import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import App from './App.tsx';
import './index.css';

function LaunchSplash() {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const started = Date.now();
    const finish = () => {
      const wait = Math.max(0, 1250 - (Date.now() - started));
      window.setTimeout(() => {
        setLeaving(true);
        window.setTimeout(() => setVisible(false), 520);
      }, wait);
    };
    if (document.readyState === 'complete') finish();
    else window.addEventListener('load', finish, { once: true });
    const fallback = window.setTimeout(finish, 2600);
    return () => {
      window.removeEventListener('load', finish);
      window.clearTimeout(fallback);
    };
  }, []);

  if (!visible) return null;
  return (
    <div className={`zx-launch-splash ${leaving ? 'zx-launch-splash--leaving' : ''}`} aria-label="Launching ZX Stream">
      <div className="zx-splash-orbit zx-splash-orbit--one" />
      <div className="zx-splash-orbit zx-splash-orbit--two" />
      <img className="zx-splash-logo" src="/zx-stream-icon.svg" alt="ZX Stream" />
      <div className="zx-splash-wordmark">ZX <span>STREAM</span></div>
      <div className="zx-splash-tagline">WATCH <i /> DOWNLOAD <i /> ENJOY</div>
      <div className="zx-splash-loader"><span /></div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <LaunchSplash />
  </>
);
