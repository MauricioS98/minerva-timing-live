import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { EventsPage } from "./pages/EventsPage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { PublicBoardPage } from "./pages/PublicBoardPage";
import { OverlayPage } from "./pages/OverlayPage";
import { StartOrderOverlayPage } from "./overlays/redbull/StartOrderOverlay";

export default function App() {
  const location = useLocation();
  const isBoard = location.pathname.startsWith("/tablero/");
  const isOverlay = location.pathname.startsWith("/overlay/");

  if (isOverlay) {
    return (
      <Routes>
        <Route path="/overlay/:id/orden-salida" element={<StartOrderOverlayPage />} />
        <Route path="/overlay/:id" element={<OverlayPage />} />
      </Routes>
    );
  }

  if (isBoard) {
    return (
      <Routes>
        <Route path="/tablero/:id" element={<PublicBoardPage />} />
      </Routes>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Minerva</span>
          <span className="brand-sub">Timing</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Eventos
          </NavLink>
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<EventsPage />} />
          <Route path="/eventos/:id" element={<EventDetailPage />} />
        </Routes>
      </main>
    </div>
  );
}
