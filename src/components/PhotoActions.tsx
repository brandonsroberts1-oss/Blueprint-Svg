import { useRef, useState } from 'react';
import { importPhoto } from '../lib/image/imageUtils';
import { hasPhotoWork, withoutPhoto } from '../lib/model/photo';
import { useStore } from '../state/store';
import { useUI } from '../state/ui';

const UNDO_NOTE = 'You can undo this with ↶.';

export function usePhotoActions() {
  const { project, update } = useStore();
  const { setStep, notify, setSelectedId } = useUI();
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      notify('Please choose an image file (JPG, PNG or WebP).', 'error');
      return;
    }
    if (hasPhotoWork(project) && !confirm(`Use this new photo? The tracing on the current photo will be cleared. ${UNDO_NOTE}`)) return;
    setBusy(true);
    try {
      const photo = await importPhoto(file);
      const { width: W, height: H } = photo;
      update((p) => ({
        ...withoutPhoto(p),
        straighten: {
          original: photo,
          quad: [
            { x: W * 0.22, y: H * 0.34 },
            { x: W * 0.78, y: H * 0.34 },
            { x: W * 0.78, y: H * 0.78 },
            { x: W * 0.22, y: H * 0.78 },
          ],
          aspect: null,
        },
        groundY: H * 0.85,
      }));
      setSelectedId(null);
      setStep('straighten');
    } catch (e) {
      notify(`Could not read that photo: ${(e as Error).message}. HEIC photos may need converting to JPG first.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (hasPhotoWork(project) && !confirm(`Remove the photo? The tracing on it will be cleared. ${UNDO_NOTE}`)) return;
    update(withoutPhoto);
    setSelectedId(null);
    setStep('photo');
    notify('Photo removed. Choose or drop a new one.', 'info');
  };

  return { upload, remove, busy, hasPhoto: !!(project.photo || project.straighten) };
}

/** A button that opens the file chooser and swaps in the chosen photo. */
export function ChangePhotoButton({ className = 'btn', label = 'Change photo…', title }: { className?: string; label?: string; title?: string }) {
  const { upload, busy } = usePhotoActions();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} disabled={busy} title={title} onClick={() => fileRef.current?.click()}>
        {busy ? 'Loading…' : label}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = '';
        }}
      />
    </>
  );
}
