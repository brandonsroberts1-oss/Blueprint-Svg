"""Rebuild public/models/*.onnx — the three on-device auto-trace models.

    python -m venv .venv && .venv/bin/pip install ultralytics onnx onnxruntime onnxslim
    .venv/bin/python scripts/export-models.py

Weights are downloaded from the Ultralytics GitHub releases (AGPL-3.0). The ONNX
files are trimmed to the outputs the browser uses and their weights are stored
compactly (int8 per output channel for the detectors, float16 for the segmenter);
onnxruntime folds them back to float32 when a session is created.
"""
import os
import shutil

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from ultralytics import YOLO, YOLOE

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'models')
os.makedirs(OUT, exist_ok=True)


def keep_rows(path: str, rows: list[int], name: str = 'boxes') -> onnx.ModelProto:
    """Gather a subset of rows (box + chosen classes) from a YOLO head output."""
    m = onnx.load(path)
    out = m.graph.output[0]
    anchors = out.type.tensor_type.shape.dim[2].dim_value
    m.graph.initializer.append(numpy_helper.from_array(np.array(rows, dtype=np.int64), 'keep_rows'))
    m.graph.node.append(helper.make_node('Gather', [out.name, 'keep_rows'], [name], axis=1, name='keep_rows'))
    while len(m.graph.output):
        m.graph.output.remove(m.graph.output[0])
    m.graph.output.append(helper.make_tensor_value_info(name, TensorProto.FLOAT, [1, len(rows), anchors]))
    return m


def int8_weights(m: onnx.ModelProto, min_size: int = 4096) -> onnx.ModelProto:
    """Store Conv/MatMul weights as int8 (per output channel) behind a DequantizeLinear."""
    g = m.graph
    uses: dict[str, list] = {}
    for n in g.node:
        for k, name in enumerate(n.input):
            uses.setdefault(name, []).append((n, k))
    new_inits, new_nodes, removed = [], [], set()
    for init in list(g.initializer):
        arr = numpy_helper.to_array(init)
        users = uses.get(init.name, [])
        if arr.dtype != np.float32 or arr.size < min_size or arr.ndim < 2 or not users:
            continue
        if not all(n.op_type in ('Conv', 'MatMul', 'Gemm', 'ConvTranspose') and k == 1 for n, k in users):
            continue
        axis = 1 if users[0][0].op_type == 'MatMul' else 0
        flat = np.moveaxis(arr, axis, 0).reshape(arr.shape[axis], -1)
        scale = np.abs(flat).max(axis=1) / 127.0
        scale[scale == 0] = 1e-8
        shape = [1] * arr.ndim
        shape[axis] = -1
        q = np.clip(np.round(arr / scale.reshape(shape)), -127, 127).astype(np.int8)
        new_inits += [numpy_helper.from_array(q, init.name + '_q'), numpy_helper.from_array(scale.astype(np.float32), init.name + '_s')]
        new_nodes.append(helper.make_node('DequantizeLinear', [init.name + '_q', init.name + '_s'], [init.name], axis=axis, name=init.name + '_dq'))
        removed.add(init.name)
    return _swap(m, new_inits, new_nodes, removed)


def fp16_weights(m: onnx.ModelProto, min_size: int = 1024) -> onnx.ModelProto:
    """Store float32 initializers as float16 behind a Cast back to float32."""
    new_inits, new_nodes, removed = [], [], set()
    for init in list(m.graph.initializer):
        arr = numpy_helper.to_array(init)
        if arr.dtype != np.float32 or arr.size < min_size:
            continue
        new_inits.append(numpy_helper.from_array(arr.astype(np.float16), init.name + '_h'))
        new_nodes.append(helper.make_node('Cast', [init.name + '_h'], [init.name], to=TensorProto.FLOAT, name=init.name + '_cast'))
        removed.add(init.name)
    return _swap(m, new_inits, new_nodes, removed)


def _swap(m, new_inits, new_nodes, removed):
    g = m.graph
    kept = [i for i in g.initializer if i.name not in removed]
    del g.initializer[:]
    g.initializer.extend(kept + new_inits)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(new_nodes + nodes)
    return m


# 1. Semantic segmentation (ADE20K, 150 classes) -> class map [1, 640, 640] (uint8).
p = YOLO('yolo26s-sem-ade20k.pt').export(format='onnx', imgsz=640, opset=17, simplify=True)
onnx.save(fp16_weights(onnx.load(p)), os.path.join(OUT, 'house-seg.onnx'))

# 2. Open Images detector -> [1, 4 + 8, anchors]: window, door, house, building, porch, stairs, lamp, tree.
p = YOLO('yolov8s-oiv7.pt').export(format='onnx', imgsz=800, opset=17, simplify=True)
onnx.save(int8_weights(keep_rows(p, [0, 1, 2, 3] + [4 + c for c in (587, 164, 257, 70, 401, 489, 301, 553)])), os.path.join(OUT, 'house-openings.onnx'))

# 3. YOLOE open-vocabulary detector with fixed prompts -> [1, 4 + 9, anchors].
names = ['garage door', 'lamp', 'front door', 'chimney', 'column', 'house', 'tree', 'bush', 'car']
ye = YOLOE('yoloe-26s-seg.pt')
ye.set_classes(names, ye.get_text_pe(names))
p = ye.export(format='onnx', imgsz=640, opset=17, simplify=True)
onnx.save(int8_weights(keep_rows(p, list(range(4 + len(names))))), os.path.join(OUT, 'house-extras.onnx'))

for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
