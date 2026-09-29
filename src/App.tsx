import { useEffect, useRef } from 'react';
import { DetailsPanel } from './components/DetailsPanel';
import { ExportPanel } from './components/ExportPanel';
import { Header } from './components/Header';
import { SettingsDialog } from './components/SettingsDialog';
import { PhotoMain, PhotoPanel } from './components/PhotoStep';
import { SheetPreview } from './components/SheetPreview';
import { StraightenCanvas, StraightenPanel } from './components/StraightenStep';
import { Toasts } from './components/Toasts';
import { TraceEditor } from './components/TraceEditor';
import { TracePanel } from './components/TracePanel';
import { SheetProvider } from './state/sheet';
import { loadAutosave, useStore } from './state/store';
import { useUI } from './state/ui';

export default function App() {
  const { step, setStep, notify } = useUI();
  const { project, replace } = useStore();
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    loadAutosave().then((p) => {
      if (p && (p.photo || p.straighten || p.elements.length)) {
        replace(p, { record: false });
        setStep(p.elements.length ? 'trace' : p.photo ? 'trace' : 'straighten');
        notify('Restored your last project. Use “New” to start over.', 'info');
      }
    });
  }, [replace, setStep, notify]);

  // On phones the app is one scrolling page; start each step at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  // After undo or removing the photo, leave steps that no longer have anything to show.
  useEffect(() => {
    if (step === 'straighten' && !project.straighten) setStep(project.photo ? 'trace' : 'photo');
    else if (step !== 'photo' && step !== 'straighten' && !project.photo) setStep(project.straighten ? 'straighten' : 'photo');
  }, [step, project.photo, project.straighten, setStep]);

  return (
    <SheetProvider>
      <div className="app">
        <Header />
        <div className="body">
          <aside className="sidebar">
            {step === 'photo' && <PhotoPanel />}
            {step === 'straighten' && <StraightenPanel />}
            {step === 'trace' && <TracePanel />}
            {step === 'details' && <DetailsPanel />}
            {step === 'export' && <ExportPanel />}
          </aside>
          <main className="main">
            {step === 'photo' && <PhotoMain />}
            {step === 'straighten' && <StraightenCanvas />}
            {step === 'trace' && <TraceEditor />}
            {(step === 'details' || step === 'export') && <SheetPreview />}
          </main>
        </div>
        <SettingsDialog />
        <Toasts />
      </div>
    </SheetProvider>
  );
}
