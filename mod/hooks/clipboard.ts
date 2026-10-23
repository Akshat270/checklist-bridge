// "Paste screenshot": saves the image on the clipboard to a PNG file, with the system's own tools.
// A mod can't read a pasted image or write binary files itself, so register.tsx runs one of these
// commands with $.process.run. The file to write is passed in the CB_SHOT environment variable,
// never in the command, so a path with spaces or quotes can't break it. Each prints "ok" or "none"
// (and on Linux "notool" when neither wl-paste nor xclip is installed).

export type Platform = 'windows' | 'mac' | 'linux'

/** From the OS environment variable (Windows sets it) and, elsewhere, what `uname -s` printed. */
export function platformFrom(osVar: string | undefined, uname: string | undefined): Platform {
  if (osVar === 'Windows_NT') return 'windows'
  return /darwin/i.test(uname ?? '') ? 'mac' : 'linux'
}

export function pasteCommand(p: Platform): string[] {
  if (p === 'windows')
    return [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; ' +
        '$i = [System.Windows.Forms.Clipboard]::GetImage(); ' +
        "if ($i) { $i.Save($env:CB_SHOT, [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'none' }",
    ]
  if (p === 'mac')
    return [
      'osascript',
      '-e', 'try',
      '-e', 'set d to (the clipboard as «class PNGf»)',
      '-e', 'on error',
      '-e', 'return "none"',
      '-e', 'end try',
      '-e', 'set f to open for access (POSIX file (system attribute "CB_SHOT")) with write permission',
      '-e', 'set eof f to 0',
      '-e', 'write d to f',
      '-e', 'close access f',
      '-e', 'return "ok"',
    ]
  // Wayland first, then X11. Nothing is left behind when there is no image.
  return [
    'sh',
    '-c',
    'f="$CB_SHOT"; mkdir -p "$(dirname "$f")"; ' +
      'command -v wl-paste >/dev/null 2>&1 || command -v xclip >/dev/null 2>&1 || { echo notool; exit 0; }; ' +
      '{ wl-paste --no-newline --type image/png > "$f" 2>/dev/null || xclip -selection clipboard -t image/png -o > "$f" 2>/dev/null; } ' +
      '&& [ -s "$f" ] && echo ok || { rm -f "$f"; echo none; }',
  ]
}

/** How to put a screenshot on the clipboard, in a few words. */
export const COPY_HINT: Record<Platform, string> = {
  windows: 'Press Win+Shift+S, pick an area, then try again.',
  mac: 'Press Cmd+Ctrl+Shift+4, pick an area, then try again.',
  linux: 'Copy a screenshot to the clipboard, then try again.',
}

/** What the command printed: "ok", "none", "notool", or undefined if it didn't run. */
export const pasteResult = (stdout: string | undefined) => /\b(ok|none|notool)\s*$/.exec(stdout ?? '')?.[1]

/** What to say when nothing was pasted. */
export function noImage(p: Platform, result: string | undefined): string {
  if (result === 'notool') return 'To paste screenshots, install wl-clipboard (Wayland) or xclip (X11). Or type the file path.'
  if (!result) return 'Could not read the clipboard. Type the screenshot\'s file path instead.'
  return `No image on the clipboard. ${COPY_HINT[p]}`
}
