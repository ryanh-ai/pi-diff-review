import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { open, type GlimpseWindow } from "glimpseui";
import { getAvailableBranches, getCurrentBranchOrRef, getDiffReviewFiles, validateRef } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type { ChangeRefPayload, DiffReviewFile, ReviewSubmitPayload, ReviewWindowMessage } from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isChangeRefPayload(value: ReviewWindowMessage): value is ChangeRefPayload {
  return value.type === "change-ref";
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  async function reviewDiff(ctx: ExtensionCommandContext): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A diff review window is already open.", "warning");
      return;
    }

    const { repoRoot, files, comparisonRef } = await getDiffReviewFiles(pi, ctx.cwd);
    const [branches, currentBranch] = await Promise.all([
      getAvailableBranches(pi, repoRoot),
      getCurrentBranchOrRef(pi, repoRoot),
    ]);

    if (files.length === 0) {
      ctx.ui.notify("No git diff to review.", "info");
      return;
    }

    const html = buildReviewHtml({ repoRoot, files, comparisonRef, availableBranches: branches, currentBranch });
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: "pi diff review",
    });
    activeWindow = window;

    ctx.ui.notify("Opened native diff review window.", "info");

    // Track current state for ref changes
    let currentFiles: DiffReviewFile[] = files;
    let currentRef = comparisonRef;
    let changeRefRequestId = 0;

    try {
      const message = await new Promise<ReviewWindowMessage | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewWindowMessage | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onMessage = async (data: unknown): Promise<void> => {
          const msg = data as ReviewWindowMessage;

          if (isChangeRefPayload(msg)) {
            // Handle branch change without closing window
            const requestId = ++changeRefRequestId;
            const newRef = msg.ref;

            try {
              // Validate the ref first
              const valid = await validateRef(pi, repoRoot, newRef);
              if (!valid) {
                // Send error back to UI
                if (requestId === changeRefRequestId && activeWindow === window) {
                  const errorPayload = JSON.stringify({ type: "ref-change-error", error: `Invalid ref: ${newRef}` });
                  window.send(`window.dispatchEvent(new CustomEvent("extension-message", { detail: ${errorPayload} }))`);
                }
                return;
              }

              const { files: newFiles, comparisonRef: resolvedRef } = await getDiffReviewFiles(pi, ctx.cwd, newRef);

              // Check for race condition — only apply if this is still the latest request
              if (requestId !== changeRefRequestId || activeWindow !== window) return;

              currentFiles = newFiles;
              currentRef = resolvedRef;

              // Send updated data to the web UI
              const updatePayload = JSON.stringify({
                type: "ref-changed",
                comparisonRef: resolvedRef,
                files: newFiles,
              });
              // Escape for JS eval context
              const escaped = updatePayload
                .replace(/\\/g, "\\\\")
                .replace(/'/g, "\\'")
                .replace(/</g, "\\u003c")
                .replace(/>/g, "\\u003e");
              window.send(`window.dispatchEvent(new CustomEvent("extension-message", { detail: JSON.parse('${escaped}') }))`);
            } catch (error) {
              if (requestId === changeRefRequestId && activeWindow === window) {
                const errMsg = error instanceof Error ? error.message : String(error);
                const errorPayload = JSON.stringify({ type: "ref-change-error", error: errMsg });
                const escaped = errorPayload
                  .replace(/\\/g, "\\\\")
                  .replace(/'/g, "\\'")
                  .replace(/</g, "\\u003c")
                  .replace(/>/g, "\\u003e");
                window.send(`window.dispatchEvent(new CustomEvent("extension-message", { detail: JSON.parse('${escaped}') }))`);
              }
            }
            return;
          }

          settle(msg);
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      if (!isSubmitPayload(message)) {
        ctx.ui.notify("Diff review returned an unknown payload.", "error");
        return;
      }

      const prompt = composeReviewPrompt(currentFiles, message, currentRef);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted diff review feedback into the editor.", "info");
    } catch (error) {
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diff review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native diff review window and insert review feedback into the editor",
    handler: async (_args, ctx) => {
      await reviewDiff(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    closeActiveWindow();
  });
}
