import { useEffect, useRef, useState } from 'preact/hooks';
import { clampView, DOUBLE_TAP_SCALE, IDENTITY, zoomAt, type View } from './zoom.js';

// Просмотр фото во весь экран с приближением пальцами. Масштабирование страницы в Mini
// App выключено (`user-scalable=no` — иначе Telegram дёргает весь интерфейс), поэтому жесты свои:
// два пальца — приближение вокруг точки между ними, один палец при приближении — сдвиг, двойное
// касание — приблизить/вернуть. Закрытие — кнопкой или касанием, когда фото не приближено.

interface Pt { x: number; y: number }

const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

export function PhotoViewer(props: { src: string; closeLabel: string; onClose: () => void }): preact.JSX.Element {
  const [view, setView] = useState<View>(IDENTITY);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Pt>());
  const pinch = useRef<{ dist: number; view: View; mid: Pt } | null>(null);
  const pan = useRef<{ start: Pt; view: View; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Пока фото открыто, вертикальный жест не сворачивает Mini App (Telegram 7.7+): иначе сдвиг
  // приближенного фото вниз закрывал бы приложение.
  useEffect(() => {
    const wa = (window as unknown as { Telegram?: { WebApp?: { disableVerticalSwipes?: () => void; enableVerticalSwipes?: () => void } } }).Telegram?.WebApp;
    try { wa?.disableVerticalSwipes?.(); } catch { /* старый клиент */ }
    return () => { try { wa?.enableVerticalSwipes?.(); } catch { /* старый клиент */ } };
  }, []);

  /** Точка относительно центра экрана. */
  const rel = (p: Pt): Pt => {
    const r = box.current!.getBoundingClientRect();
    return { x: p.x - (r.left + r.width / 2), y: p.y - (r.top + r.height / 2) };
  };
  const bounded = (v: View): View => {
    const r = box.current?.getBoundingClientRect();
    const i = img.current;
    if (!r || !i) return v;
    return clampView(v, i.clientWidth, i.clientHeight, r.width, r.height);
  };

  const down = (e: PointerEvent): void => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const [a, b] = pts as [Pt, Pt];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), view: viewRef.current, mid: rel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
      pan.current = null;
    } else if (pts.length === 1) {
      pan.current = { start: { x: e.clientX, y: e.clientY }, view: viewRef.current, moved: false };
    }
  };

  const move = (e: PointerEvent): void => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pinch.current && pts.length >= 2) {
      const [a, b] = pts as [Pt, Pt];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = rel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const p = pinch.current;
      // Приближение вокруг начальной середины плюс сдвиг вслед за пальцами.
      const z = zoomAt(p.view, p.view.scale * (dist / Math.max(1, p.dist)), p.mid.x, p.mid.y);
      setView(bounded({ ...z, x: z.x + (mid.x - p.mid.x), y: z.y + (mid.y - p.mid.y) }));
    } else if (pan.current && pts.length === 1) {
      const dx = e.clientX - pan.current.start.x;
      const dy = e.clientY - pan.current.start.y;
      if (Math.hypot(dx, dy) > TAP_SLOP) pan.current.moved = true;
      if (pan.current.view.scale > 1) setView(bounded({ ...pan.current.view, x: pan.current.view.x + dx, y: pan.current.view.y + dy }));
    }
  };

  const up = (e: PointerEvent): void => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size > 0) {
      // Второй палец поднят — оставшийся продолжает сдвиг с текущего положения.
      const [p] = [...pointers.current.values()] as [Pt];
      pan.current = { start: p, view: viewRef.current, moved: true };
      return;
    }
    const tap = pan.current && !pan.current.moved;
    pan.current = null;
    if (!tap) return;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      const c = rel({ x: e.clientX, y: e.clientY });
      setView(viewRef.current.scale > 1 ? IDENTITY : bounded(zoomAt(viewRef.current, DOUBLE_TAP_SCALE, c.x, c.y)));
      return;
    }
    lastTap.current = now;
    // Одиночное касание по неприближенному фото закрывает — но не сразу: вдруг это начало двойного.
    if (viewRef.current.scale <= 1) {
      const at = now;
      setTimeout(() => { if (lastTap.current === at && viewRef.current.scale <= 1) props.onClose(); }, DOUBLE_TAP_MS);
    }
  };

  return (
    <div ref={box} class="photo-viewer" role="dialog" aria-label={props.closeLabel}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <img ref={img} src={props.src} alt="" draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
      <button class="photo-close" aria-label={props.closeLabel}
        onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); props.onClose(); }}>×</button>
    </div>
  );
}
