"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ACCEPTED_TYPES, MAX_PICKED_BYTES, UPLOAD_SIDE_PX, centerCropSquare } from "@/lib/avatar-crop";

type Status =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "saving"; percent: number }
  | { kind: "removing" }
  | { kind: "confirm-remove" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium disabled:opacity-50";
const PRIMARY = `${BUTTON} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;
const SECONDARY = `${BUTTON} ring-1 ring-zinc-300 hover:bg-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800`;

/**
 * Set, preview, replace and remove the profile picture. The browser shrinks the picture to a 512 px centre square
 * first (fast on a phone, and exactly what the circle will show); services/api then checks and re-encodes the real
 * bytes, so nothing here is trusted. If a save fails, the picture the player already has stays.
 */
export function AvatarEditor({ currentUrl, color, username }: { currentUrl: string | null; color: string; username: string }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ blob: Blob; previewUrl: string } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "reading" || status.kind === "saving" || status.kind === "removing";

  useEffect(() => () => void (picked && URL.revokeObjectURL(picked.previewUrl)), [picked]);

  function fail(message: string) {
    setStatus({ kind: "error", message });
  }

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // choosing the same file again must still fire
    if (!file) return;
    if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return fail("That file type is not supported. Use a JPEG, PNG or WebP picture.");
    if (file.size > MAX_PICKED_BYTES) return fail("That picture is too large to open. Choose a smaller one.");
    setStatus({ kind: "reading" });
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const { sx, sy, side } = centerCropSquare(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = UPLOAD_SIDE_PX;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no canvas");
      context.drawImage(bitmap, sx, sy, side, side, 0, 0, UPLOAD_SIDE_PX, UPLOAD_SIDE_PX);
      bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
      const finished = blob && blob.type === "image/webp" ? blob : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!finished) throw new Error("no blob");
      setPicked({ blob: finished, previewUrl: URL.createObjectURL(finished) });
      setStatus({ kind: "idle" });
    } catch {
      fail("We could not read that picture. Try a different JPEG, PNG or WebP file.");
    }
  }

  function save() {
    if (!picked) return;
    // XMLHttpRequest, because fetch cannot report upload progress.
    const request = new XMLHttpRequest();
    request.open("PUT", "/api/profile/avatar");
    request.setRequestHeader("content-type", picked.blob.type);
    request.upload.onprogress = (progress) => {
      if (progress.lengthComputable) setStatus({ kind: "saving", percent: Math.round((progress.loaded / progress.total) * 100) });
    };
    request.onerror = () => fail("We could not reach the server. Your current picture is unchanged. Check your connection and try again.");
    request.ontimeout = request.onerror;
    request.timeout = 30_000;
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        setPicked(null);
        setStatus({ kind: "done", message: "Picture saved. It will show on the World within a few seconds." });
        router.refresh();
        return;
      }
      let message = "We could not save your picture. Your current picture is unchanged; try again in a moment.";
      try {
        const body = JSON.parse(request.responseText) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // keep the generic message
      }
      fail(message);
    };
    setStatus({ kind: "saving", percent: 0 });
    request.send(picked.blob);
  }

  async function remove() {
    setStatus({ kind: "removing" });
    try {
      const response = await fetch("/api/profile/avatar", { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        return fail(body?.error?.message ?? "We could not remove your picture. Try again in a moment.");
      }
      setStatus({ kind: "done", message: "Picture removed. Your country is back to its colour." });
      router.refresh();
    } catch {
      fail("We could not reach the server. Your picture is unchanged; try again in a moment.");
    }
  }

  const shownUrl = picked?.previewUrl ?? currentUrl;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <span
          aria-hidden
          className="relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full text-3xl font-bold text-white"
          style={{ backgroundColor: color, boxShadow: `0 0 0 3px ${color}` }}
        >
          {shownUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview or a 256 px public thumbnail
            <img src={shownUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            username.slice(0, 1).toUpperCase()
          )}
        </span>
        <div className="text-sm text-zinc-600 dark:text-zinc-400">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">{picked ? "Preview" : currentUrl ? "Your picture" : "No picture yet"}</p>
          <p>{picked ? "This is how it will look in your country's circle on the World." : "Your country uses its colour until you pick a picture."}</p>
        </div>
      </div>

      <input ref={fileInput} type="file" accept={ACCEPTED_TYPES.join(",")} onChange={onPick} className="sr-only" aria-label="Choose a profile picture" tabIndex={-1} />
      <div className="flex flex-col gap-2 sm:flex-row">
        {picked ? (
          <>
            <button type="button" onClick={save} disabled={busy} className={PRIMARY}>
              {status.kind === "saving" ? `Saving… ${status.percent}%` : "Save picture"}
            </button>
            <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={SECONDARY}>
              Choose a different picture
            </button>
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setStatus({ kind: "idle" });
              }}
              disabled={busy}
              className={SECONDARY}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={PRIMARY}>
              {status.kind === "reading" ? "Opening…" : currentUrl ? "Replace picture" : "Choose a picture"}
            </button>
            {currentUrl && status.kind !== "confirm-remove" && (
              <button type="button" onClick={() => setStatus({ kind: "confirm-remove" })} disabled={busy} className={SECONDARY}>
                {status.kind === "removing" ? "Removing…" : "Remove picture"}
              </button>
            )}
          </>
        )}
      </div>

      {status.kind === "saving" && (
        <div role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.percent} className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-full bg-zinc-900 transition-[width] dark:bg-zinc-100" style={{ width: `${status.percent}%` }} />
        </div>
      )}
      {status.kind === "confirm-remove" && (
        <div role="alertdialog" aria-label="Remove picture" className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          <p>Remove your picture? Your country goes back to its colour. You can add a picture again any time.</p>
          <div className="flex gap-2">
            <button type="button" onClick={remove} className={PRIMARY}>
              Yes, remove it
            </button>
            <button type="button" onClick={() => setStatus({ kind: "idle" })} className={SECONDARY}>
              Keep it
            </button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className={`text-sm font-medium ${status.kind === "error" ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>
        {status.kind === "error" || status.kind === "done" ? status.message : ""}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">JPEG, PNG or WebP, up to 2 MB. The picture is cropped to a square from its centre. Your file name and any location data in the photo are never kept.</p>
    </div>
  );
}
