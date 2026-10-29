/** Hands a fetched file to the browser as a download. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke after the click has been handled so the download isn't cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
