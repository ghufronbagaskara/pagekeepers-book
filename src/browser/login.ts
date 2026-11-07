import { cacheShell, remember } from "./local";

void cacheShell()?.catch(() => {});
const form = document.querySelector<HTMLFormElement>("form")!;
const status = document.querySelector<HTMLElement>("#status")!;
const submit = form.querySelector<HTMLButtonElement>("button")!;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  submit.disabled = true;
  try {
    const data = new FormData(form);
    const response = await fetch("/api/login/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Gagal masuk. Coba lagi.");
    remember(payload);
    location.replace("/library/");
  } catch (error) {
    status.textContent = navigator.onLine && error instanceof Error ? error.message : "Sambungkan ke internet untuk masuk.";
  } finally {
    submit.disabled = false;
  }
});
