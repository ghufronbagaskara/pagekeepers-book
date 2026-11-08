import { t } from "./i18n";

/** What the quote tool needs from the engine: where the pages sit on screen and the bitmaps behind them. */
type Box = { side: "left" | "right"; x: number; y: number; width: number; height: number };
type Engine = {
  stage: HTMLElement;
  activePage: number;
  pageMode: string;
  layout: { screenPair: (page: number) => [number, number] };
  renderer: { pageBoxes: () => Box[] };
  textureFor: (page: number) => Promise<HTMLCanvasElement | null>;
};
type Rect = { x: number; y: number; width: number; height: number };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const MIN_PX = 24;
const MAX_WIDTH = 2000;

/** Crop the chosen part of the spread, at the sharpness the pages are rendered at, with a caption strip under it. */
async function crop(reader: Engine, chosen: Rect, caption: string) {
  const [left, right] = reader.layout.screenPair(reader.activePage);
  const single = reader.pageMode === "single";
  const parts: { canvas: HTMLCanvasElement; box: Box; area: Rect }[] = [];
  for (const box of reader.renderer.pageBoxes()) {
    const page = single ? left || right : box.side === "left" ? left : right;
    const x = Math.max(chosen.x, box.x);
    const y = Math.max(chosen.y, box.y);
    const width = Math.min(chosen.x + chosen.width, box.x + box.width) - x;
    const height = Math.min(chosen.y + chosen.height, box.y + box.height) - y;
    if (!page || width <= 0 || height <= 0) continue;
    const canvas = await reader.textureFor(page);
    if (canvas) parts.push({ canvas, box, area: { x, y, width, height } });
  }
  if (!parts.length) return undefined;
  // Output pixels per screen pixel: the page bitmap's own density, capped so a huge selection stays shareable.
  const density = Math.min(Math.max(...parts.map(({ canvas, box }) => canvas.width / box.width), 1), MAX_WIDTH / chosen.width);
  const width = Math.round(chosen.width * density);
  const font = Math.max(14, Math.round(width * 0.032));
  const strip = Math.round(font * 2.2);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = Math.round(chosen.height * density) + strip;
  const draw = out.getContext("2d")!;
  draw.fillStyle = "#ffffff";
  draw.fillRect(0, 0, out.width, out.height);
  for (const { canvas, box, area } of parts) {
    const scaleX = canvas.width / box.width;
    const scaleY = canvas.height / box.height;
    draw.drawImage(canvas, (area.x - box.x) * scaleX, (area.y - box.y) * scaleY, area.width * scaleX, area.height * scaleY,
      (area.x - chosen.x) * density, (area.y - chosen.y) * density, area.width * density, area.height * density);
  }
  draw.fillStyle = "#f3ece0";
  draw.fillRect(0, out.height - strip, width, strip);
  draw.fillStyle = "#4a3b2c";
  draw.font = `600 ${font}px system-ui, sans-serif`;
  draw.textBaseline = "middle";
  let text = caption;
  while (text.length > 4 && draw.measureText(text).width > width - font * 1.6) text = text.slice(0, -2);
  if (text !== caption) text = text.slice(0, -1) + "…";
  draw.fillText(text, font * 0.8, out.height - strip / 2);
  return new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.9));
}

/** "Share a quote": drag a box over the page, then share the picture (WhatsApp and friends) or save it. */
export function setupQuote(reader: Engine, title: string, beforeStart: () => void) {
  const layer = element("quote-layer");
  const box = element("quote-box");
  const dialog = element<HTMLDialogElement>("quote-dialog");
  const preview = element<HTMLImageElement>("quote-preview");
  const shareButton = element<HTMLButtonElement>("quote-share");
  let origin: { x: number; y: number; id: number } | undefined;
  let chosen: Rect | undefined;
  let file: File | undefined;
  let url = "";

  const close = () => { layer.hidden = true; origin = undefined; box.hidden = true; };
  const start = () => {
    beforeStart();
    const rect = reader.stage.getBoundingClientRect();
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    box.hidden = true;
    layer.hidden = false;
    element("quote-cancel").focus();
  };
  const local = (event: PointerEvent) => {
    const rect = layer.getBoundingClientRect();
    return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) };
  };
  layer.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest("button") || origin) return;
    const point = local(event);
    origin = { ...point, id: event.pointerId };
    chosen = { ...point, width: 0, height: 0 };
    try { layer.setPointerCapture(event.pointerId); } catch { /* the drag still works inside the layer */ }
    event.preventDefault();
  });
  layer.addEventListener("pointermove", (event) => {
    if (!origin || event.pointerId !== origin.id) return;
    const point = local(event);
    chosen = { x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), width: Math.abs(point.x - origin.x), height: Math.abs(point.y - origin.y) };
    Object.assign(box.style, { left: `${chosen.x}px`, top: `${chosen.y}px`, width: `${chosen.width}px`, height: `${chosen.height}px` });
    box.hidden = false;
  });
  const release = async (event: PointerEvent) => {
    if (!origin || event.pointerId !== origin.id) return;
    origin = undefined;
    const area = chosen;
    if (!area || area.width < MIN_PX || area.height < MIN_PX) { box.hidden = true; return; }
    close();
    const page = reader.activePage;
    const blob = await crop(reader, area, t("{title}, page {page}", { title, page })).catch(() => null);
    if (!blob) return;
    file = new File([blob], `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}-p${page}.jpg`, { type: "image/jpeg" });
    URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    preview.src = url;
    shareButton.hidden = !navigator.canShare?.({ files: [file] });
    dialog.returnValue = "";
    dialog.showModal();
  };
  layer.addEventListener("pointerup", (event) => void release(event));
  layer.addEventListener("pointercancel", () => { origin = undefined; box.hidden = true; });
  element("quote-cancel").addEventListener("click", close);
  layer.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });

  // Both run straight from the click, which is what lets the browser open its share sheet.
  shareButton.addEventListener("click", () => {
    if (!file) return;
    navigator.share({ files: [file] }).then(() => dialog.close(), () => {});
  });
  element("quote-save").addEventListener("click", () => {
    if (!file) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    dialog.close();
  });
  return start;
}
