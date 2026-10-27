import { File } from "expo-file-system";

// One temporary file and one last-good backup per store. This protects evidence
// across interrupted writes without introducing a database or recovery engine.
export function jsonFile(file: File, valid: (value: unknown) => boolean) {
  const backup = new File(`${file.uri}.backup`);
  const corrupt = new File(`${file.uri}.corrupt`);
  const validate = (text: string) => {
    if (!valid(JSON.parse(text)))
      throw new Error(`Unsupported data in ${file.name}`);
    return text;
  };
  const replaceCopy = (from: File, to: File) => {
    if (to.exists) to.delete();
    from.copy(to);
  };
  return {
    async read(): Promise<string | null> {
      if (file.exists) {
        try {
          return validate(await file.text());
        } catch (error) {
          // Keep the first unreadable original for investigation.
          if (!corrupt.exists) file.copy(corrupt);
          if (!backup.exists) throw error;
        }
      }
      return backup.exists ? validate(await backup.text()) : null;
    },
    write(text: string) {
      validate(text);
      // File.move changes the handle URI. Use a fresh temporary handle per write.
      const temporary = new File(`${file.uri}.tmp`);
      temporary.create({ overwrite: true });
      temporary.write(text);
      if (file.exists) {
        let oldValid = false;
        try {
          validate(file.textSync());
          oldValid = true;
        } catch {
          /* Preserve corrupt evidence in read(). */
        }
        if (oldValid) replaceCopy(file, backup);
        else if (!corrupt.exists) file.copy(corrupt);
        file.delete();
      }
      temporary.move(file);
    },
  };
}
export function historyEnvelope(value: unknown, key: "results" | "reports") {
  return (
    !!value &&
    typeof value === "object" &&
    "formatVersion" in value &&
    value.formatVersion === 1 &&
    key in value &&
    Array.isArray((value as Record<string, unknown>)[key])
  );
}
