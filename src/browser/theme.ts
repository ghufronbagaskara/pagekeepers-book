import { t } from "./i18n";

/** Light or dark for the library, sign-in and admin pages. Shell.astro applies the saved choice before first paint. */
type Theme = "light" | "dark";
const key = "reader-theme";
const current = (): Theme => document.documentElement.dataset.theme === "light" ? "light" : "dark";

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#efe5d3" : "#1b1a17");
}

export function wireThemeToggle(button: HTMLButtonElement) {
  const render = () => {
    const label = t(current() === "light" ? "Switch to dark theme" : "Switch to light theme");
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  button.addEventListener("click", () => {
    const next = current() === "light" ? "dark" : "light";
    try { localStorage.setItem(key, next); } catch {}
    apply(next);
    render();
  });
  apply(current());
  render();
}
