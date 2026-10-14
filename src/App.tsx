import { Admin } from './pages/Admin';
import { AudioCheck } from './pages/AudioCheck';
import { Overlay } from './pages/Overlay';

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/overlay';
  if (path === '/admin') return <Admin />;
  if (path === '/audio-diagnostico') return <AudioCheck />;
  return <Overlay />;
}
