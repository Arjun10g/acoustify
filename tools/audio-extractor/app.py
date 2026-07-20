from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError as exc:  # pragma: no cover - platform packaging issue
    raise SystemExit(
        "Tkinter is not installed. Run the included installer, or use cli.py instead."
    ) from exc

from core import (
    APP_NAME,
    DEFAULT_OUTPUT_DIR,
    MODE_DESCRIPTIONS,
    MODE_LABELS,
    AudioMode,
    DownloadOptions,
    ValidationError,
    build_command,
    check_dependencies,
    open_folder,
    parse_status_line,
    percent_as_float,
)


class ExtractorApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_NAME)
        self.geometry("820x690")
        self.minsize(720, 620)

        self._events: queue.Queue[tuple[str, object]] = queue.Queue()
        self._process: subprocess.Popen[str] | None = None
        self._worker: threading.Thread | None = None
        self._cancel_requested = False
        self._completed_files: list[Path] = []

        self.url_var = tk.StringVar()
        self.output_var = tk.StringVar(value=str(DEFAULT_OUTPUT_DIR))
        self.mode_var = tk.StringVar(value=AudioMode.BEST_SOURCE.value)
        self.playlist_var = tk.BooleanVar(value=False)
        self.playlist_limit_var = tk.IntVar(value=25)
        self.metadata_var = tk.BooleanVar(value=True)
        self.thumbnail_var = tk.BooleanVar(value=True)
        self.rights_var = tk.BooleanVar(value=False)
        self.status_var = tk.StringVar(value="Checking dependencies…")
        self.mode_note_var = tk.StringVar(
            value=MODE_DESCRIPTIONS[AudioMode.BEST_SOURCE]
        )
        self.progress_detail_var = tk.StringVar(value="")

        self._configure_style()
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(150, self._dependency_check)
        self.after(100, self._drain_events)

    def _configure_style(self) -> None:
        style = ttk.Style(self)
        try:
            if sys.platform == "darwin":
                style.theme_use("aqua")
            elif sys.platform.startswith("win"):
                style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("Header.TLabel", font=("TkDefaultFont", 22, "bold"))
        style.configure("Subhead.TLabel", font=("TkDefaultFont", 11))
        style.configure("Note.TLabel", font=("TkDefaultFont", 9))

    def _build_ui(self) -> None:
        outer = ttk.Frame(self, padding=22)
        outer.pack(fill="both", expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(10, weight=1)

        ttk.Label(outer, text=APP_NAME, style="Header.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            outer,
            text="Save an authorized YouTube episode as a high-quality local audio file.",
            style="Subhead.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(2, 18))

        url_frame = ttk.LabelFrame(outer, text="Episode or playlist URL", padding=12)
        url_frame.grid(row=2, column=0, sticky="ew")
        url_frame.columnconfigure(0, weight=1)
        self.url_entry = ttk.Entry(url_frame, textvariable=self.url_var)
        self.url_entry.grid(row=0, column=0, sticky="ew", padx=(0, 8))
        ttk.Button(url_frame, text="Paste", command=self._paste_url).grid(
            row=0, column=1
        )

        output_frame = ttk.LabelFrame(outer, text="Save folder", padding=12)
        output_frame.grid(row=3, column=0, sticky="ew", pady=(10, 0))
        output_frame.columnconfigure(0, weight=1)
        ttk.Entry(output_frame, textvariable=self.output_var).grid(
            row=0, column=0, sticky="ew", padx=(0, 8)
        )
        ttk.Button(output_frame, text="Choose…", command=self._choose_output).grid(
            row=0, column=1
        )

        settings = ttk.LabelFrame(outer, text="Audio settings", padding=12)
        settings.grid(row=4, column=0, sticky="ew", pady=(10, 0))
        settings.columnconfigure(1, weight=1)

        ttk.Label(settings, text="Format").grid(
            row=0, column=0, sticky="w", padx=(0, 10)
        )
        mode_box = ttk.Combobox(
            settings,
            state="readonly",
            values=[MODE_LABELS[mode] for mode in AudioMode],
            width=52,
        )
        mode_box.current(0)
        mode_box.grid(row=0, column=1, sticky="ew")
        mode_box.bind("<<ComboboxSelected>>", self._mode_selected)
        self.mode_box = mode_box

        ttk.Label(
            settings,
            textvariable=self.mode_note_var,
            wraplength=680,
            style="Note.TLabel",
        ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(7, 10))

        playlist_row = ttk.Frame(settings)
        playlist_row.grid(row=2, column=0, columnspan=2, sticky="ew")
        ttk.Checkbutton(
            playlist_row,
            text="Download playlist",
            variable=self.playlist_var,
            command=self._toggle_playlist,
        ).pack(side="left")
        ttk.Label(playlist_row, text="Maximum episodes:").pack(
            side="left", padx=(18, 6)
        )
        self.limit_spin = ttk.Spinbox(
            playlist_row,
            from_=1,
            to=250,
            width=6,
            textvariable=self.playlist_limit_var,
            state="disabled",
        )
        self.limit_spin.pack(side="left")

        extras = ttk.Frame(settings)
        extras.grid(row=3, column=0, columnspan=2, sticky="w", pady=(10, 0))
        ttk.Checkbutton(
            extras,
            text="Embed title, creator, date, and chapters",
            variable=self.metadata_var,
        ).pack(side="left")
        ttk.Checkbutton(
            extras,
            text="Embed cover artwork",
            variable=self.thumbnail_var,
        ).pack(side="left", padx=(18, 0))

        rights_frame = ttk.Frame(outer)
        rights_frame.grid(row=5, column=0, sticky="ew", pady=(13, 0))
        ttk.Checkbutton(
            rights_frame,
            variable=self.rights_var,
            text=(
                "I own this content, have the rights holder's permission, or YouTube/its license "
                "expressly permits this download."
            ),
        ).pack(anchor="w")

        actions = ttk.Frame(outer)
        actions.grid(row=6, column=0, sticky="ew", pady=(14, 0))
        actions.columnconfigure(0, weight=1)
        self.download_button = ttk.Button(
            actions, text="Download audio", command=self._start_download
        )
        self.download_button.grid(row=0, column=0, sticky="w")
        self.cancel_button = ttk.Button(
            actions, text="Cancel", command=self._cancel_download, state="disabled"
        )
        self.cancel_button.grid(row=0, column=1, padx=(8, 0))
        self.open_button = ttk.Button(
            actions, text="Open save folder", command=self._open_output_folder
        )
        self.open_button.grid(row=0, column=2, padx=(8, 0))

        progress_frame = ttk.Frame(outer)
        progress_frame.grid(row=7, column=0, sticky="ew", pady=(15, 0))
        progress_frame.columnconfigure(0, weight=1)
        self.progress = ttk.Progressbar(progress_frame, maximum=100, mode="determinate")
        self.progress.grid(row=0, column=0, sticky="ew")
        ttk.Label(progress_frame, textvariable=self.progress_detail_var, width=20).grid(
            row=0, column=1, padx=(10, 0), sticky="e"
        )
        ttk.Label(outer, textvariable=self.status_var).grid(
            row=8, column=0, sticky="w", pady=(7, 0)
        )

        log_frame = ttk.LabelFrame(outer, text="Activity", padding=8)
        log_frame.grid(row=10, column=0, sticky="nsew", pady=(12, 0))
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_text = tk.Text(log_frame, height=10, wrap="word", state="disabled")
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(
            log_frame, orient="vertical", command=self.log_text.yview
        )
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=scrollbar.set)

        ttk.Label(
            outer,
            text=(
                "No login cookies, paywall bypass, DRM circumvention, age-gate bypass, or "
                "geo-restriction bypass is included."
            ),
            style="Note.TLabel",
        ).grid(row=11, column=0, sticky="w", pady=(8, 0))

        self.url_entry.focus_set()

    def _dependency_check(self) -> None:
        status = check_dependencies()
        if status.required_ok:
            self.status_var.set("Ready.")
            self.download_button.configure(state="normal")
            self._log("Dependencies are ready.")
            if not status.deno:
                self._log(
                    "Warning: Deno was not found. yt-dlp can still try, but current YouTube support "
                    "is more reliable with Deno installed."
                )
        else:
            missing = ", ".join(status.missing_required)
            self.status_var.set(f"Missing required dependency: {missing}")
            self.download_button.configure(state="disabled")
            self._log(f"Run the included installer. Missing: {missing}")

    def _paste_url(self) -> None:
        try:
            self.url_var.set(self.clipboard_get().strip())
        except tk.TclError:
            messagebox.showinfo(APP_NAME, "The clipboard does not contain text.")

    def _choose_output(self) -> None:
        selected = filedialog.askdirectory(
            title="Choose where audio files will be saved",
            initialdir=self.output_var.get() or str(Path.home()),
        )
        if selected:
            self.output_var.set(selected)

    def _mode_selected(self, _event: object = None) -> None:
        selected_label = self.mode_box.get()
        for mode, label in MODE_LABELS.items():
            if selected_label == label:
                self.mode_var.set(mode.value)
                self.mode_note_var.set(MODE_DESCRIPTIONS[mode])
                return

    def _toggle_playlist(self) -> None:
        self.limit_spin.configure(
            state="normal" if self.playlist_var.get() else "disabled"
        )

    def _make_options(self) -> DownloadOptions:
        try:
            mode = AudioMode(self.mode_var.get())
        except ValueError as exc:
            raise ValidationError("Choose a valid audio format.") from exc

        try:
            playlist_limit = int(self.playlist_limit_var.get())
        except (tk.TclError, ValueError) as exc:
            raise ValidationError("Playlist limit must be a number.") from exc

        output_text = self.output_var.get().strip()
        if not output_text:
            raise ValidationError("Choose a save folder.")

        return DownloadOptions(
            url=self.url_var.get(),
            output_dir=Path(output_text),
            mode=mode,
            include_playlist=self.playlist_var.get(),
            playlist_limit=playlist_limit,
            embed_metadata=self.metadata_var.get(),
            embed_thumbnail=self.thumbnail_var.get(),
        )

    def _start_download(self) -> None:
        if self._process is not None:
            return
        if not self.rights_var.get():
            messagebox.showwarning(
                APP_NAME,
                "Confirm that you are authorized to save this content before downloading.",
            )
            return

        try:
            options = self._make_options()
            options.output_dir.expanduser().mkdir(parents=True, exist_ok=True)
            dependencies = check_dependencies()
            if not dependencies.required_ok or not dependencies.ytdlp_prefix:
                raise RuntimeError(
                    "Required dependencies are missing. Run the included installer first."
                )
            command = build_command(options, dependencies.ytdlp_prefix)
        except (ValidationError, RuntimeError, OSError) as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return

        self._cancel_requested = False
        self._completed_files.clear()
        self.progress.configure(value=0)
        self.progress_detail_var.set("")
        self.status_var.set("Starting download…")
        self.download_button.configure(state="disabled")
        self.cancel_button.configure(state="normal")
        self._log("Starting authorized audio download.")

        self._worker = threading.Thread(
            target=self._run_process,
            args=(command,),
            name="yt-dlp-worker",
            daemon=True,
        )
        self._worker.start()

    def _run_process(self, command: list[str]) -> None:
        creationflags = 0
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            creationflags = subprocess.CREATE_NO_WINDOW

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"

        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                creationflags=creationflags,
            )
            self._process = process
            assert process.stdout is not None
            for line in process.stdout:
                self._events.put(("line", line))
            return_code = process.wait()
            self._events.put(("finished", return_code))
        except Exception as exc:  # pragma: no cover - platform/process failure
            self._events.put(("exception", str(exc)))
        finally:
            self._process = None

    def _cancel_download(self) -> None:
        process = self._process
        if process is None:
            return
        self._cancel_requested = True
        self.status_var.set("Cancelling…")
        self.cancel_button.configure(state="disabled")
        try:
            process.terminate()
        except OSError:
            pass
        self.after(2500, self._force_kill_if_needed)

    def _force_kill_if_needed(self) -> None:
        process = self._process
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass

    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self._events.get_nowait()
                if kind == "line":
                    self._handle_line(str(payload))
                elif kind == "finished":
                    self._handle_finished(int(payload))
                elif kind == "exception":
                    self._handle_exception(str(payload))
        except queue.Empty:
            pass
        self.after(100, self._drain_events)

    def _handle_line(self, line: str) -> None:
        event = parse_status_line(line)
        if event.kind == "progress":
            percent = percent_as_float(event.value)
            if percent is not None:
                self.progress.configure(value=percent)
            speed = event.extra[0] if event.extra else ""
            eta = event.extra[1] if len(event.extra) > 1 else ""
            detail = " · ".join(
                part for part in (speed, f"ETA {eta}" if eta else "") if part
            )
            self.progress_detail_var.set(detail)
        elif event.kind == "title":
            self.status_var.set(f"Downloading: {event.value}")
            self._log(f"Episode: {event.value}")
        elif event.kind == "postprocess":
            processor = event.extra[0] if event.extra else "audio"
            self.status_var.set(f"Finishing audio file: {processor}")
        elif event.kind == "output":
            path = Path(event.value)
            self._completed_files.append(path)
            self._log(f"Saved: {path}")
        elif event.kind in {"error", "warning", "log"}:
            self._log(event.value)

    def _handle_finished(self, return_code: int) -> None:
        self.download_button.configure(state="normal")
        self.cancel_button.configure(state="disabled")
        self.progress_detail_var.set("")
        if self._cancel_requested:
            self.status_var.set(
                "Cancelled. A .part file may remain and can be resumed later."
            )
            self._log("Download cancelled.")
            return
        if return_code == 0:
            self.progress.configure(value=100)
            count = len(self._completed_files)
            noun = "file" if count == 1 else "files"
            self.status_var.set(f"Complete — saved {count} {noun}.")
            self._log("Finished successfully.")
        else:
            self.status_var.set("Download failed. Review the activity log.")
            self._log(f"yt-dlp exited with code {return_code}.")
            messagebox.showerror(
                APP_NAME,
                "The download did not complete. Update the extractor and review the activity log. "
                "Private, restricted, removed, or unauthorized videos are not supported.",
            )

    def _handle_exception(self, message: str) -> None:
        self.download_button.configure(state="normal")
        self.cancel_button.configure(state="disabled")
        self.status_var.set("Could not start the download process.")
        self._log(message)
        messagebox.showerror(APP_NAME, message)

    def _open_output_folder(self) -> None:
        try:
            output = Path(self.output_var.get()).expanduser()
            output.mkdir(parents=True, exist_ok=True)
            open_folder(output)
        except OSError as exc:
            messagebox.showerror(APP_NAME, f"Could not open the folder: {exc}")

    def _log(self, message: str) -> None:
        if not message:
            return
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message.rstrip() + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _on_close(self) -> None:
        process = self._process
        if process is not None:
            should_close = messagebox.askyesno(
                APP_NAME,
                "A download is active. Cancel it and close the app?",
            )
            if not should_close:
                return
            self._cancel_requested = True
            try:
                process.terminate()
                process.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                except OSError:
                    pass
            except OSError:
                pass
        self.destroy()


def main() -> int:
    app = ExtractorApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
