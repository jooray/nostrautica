/**
 * PWA install hint (UI-SUGGESTIONS #24). `beforeinstallprompt` fires once, early,
 * on Chrome/Android — before any event page mounts — so we capture it globally at
 * boot and stash the deferred prompt here. Pages read `install.canPrompt` to show
 * a "capture + prompt on tap" button; iOS Safari never fires the event, so those
 * pages fall back to share-sheet instructions (detected via `install.isIos`).
 * Dismissal is persisted per hint id; we never show anything in standalone mode.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_PREFIX = "nostrautica:install-hint:";

function dismissed(id: string): boolean {
  try {
    return localStorage.getItem(DISMISS_PREFIX + id) === "1";
  } catch {
    return true; // no storage → don't nag
  }
}

class InstallState {
  private deferred: BeforeInstallPromptEvent | null = null;
  private initialized = false;
  /** True once a captured prompt is available (Chrome/Android). */
  canPrompt = $state(false);

  /**
   * Capture the deferred prompt. Idempotent: called synchronously at the top of
   * the layout's onMount (UX-21 — `beforeinstallprompt` fires early and never
   * waits for the async boot), with registerPwa() as a backstop.
   */
  init(): void {
    if (typeof window === "undefined" || this.initialized) return;
    this.initialized = true;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault(); // keep it; show our own hint instead
      this.deferred = e as BeforeInstallPromptEvent;
      this.canPrompt = true;
    });
    window.addEventListener("appinstalled", () => {
      this.deferred = null;
      this.canPrompt = false;
    });
  }

  /** Running as an installed app already — never hint. */
  get isStandalone(): boolean {
    if (typeof window === "undefined") return true;
    return (
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari exposes this non-standard flag instead of display-mode.
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    );
  }

  get isIos(): boolean {
    if (typeof navigator === "undefined") return false;
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  /** Whether to surface the hint with this id: not standalone, not dismissed,
   *  and either a real prompt is available or we can show iOS instructions. */
  shouldShow(id: string): boolean {
    if (this.isStandalone || dismissed(id)) return false;
    return this.canPrompt || this.isIos;
  }

  /** Fire the native install prompt; returns true if the user accepted. */
  async promptInstall(): Promise<boolean> {
    if (!this.deferred) return false;
    const e = this.deferred;
    this.deferred = null;
    this.canPrompt = false;
    await e.prompt();
    const { outcome } = await e.userChoice;
    return outcome === "accepted";
  }

  dismiss(id: string): void {
    try {
      localStorage.setItem(DISMISS_PREFIX + id, "1");
    } catch {
      /* private mode */
    }
  }
}

export const install = new InstallState();
