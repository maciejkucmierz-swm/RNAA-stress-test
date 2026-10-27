import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

// Test-only module loading: native modules are explicit mocks; local app modules
// execute their actual code. Unexpected imports fail instead of returning {}.
export function loadModule(file: string, mocks: Record<string, unknown>) {
  const cache = new Map<string, { exports: unknown }>();
  const nativeRequire = createRequire(import.meta.url);
  function load(path: string): unknown {
    if (cache.has(path)) return cache.get(path)!.exports;
    const module = { exports: {} as unknown };
    cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    const require = (name: string): unknown => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith(".")) {
        const target = resolve(dirname(path), name);
        if (target.endsWith(".json")) return nativeRequire(target);
        const local = [
          target,
          `${target}.ts`,
          `${target}.tsx`,
          `${target}/index.ts`,
        ].find(
          (candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate),
        );
        if (!local)
          throw new Error(`Unresolved local import ${name} in ${path}`);
        return load(local);
      }
      throw new Error(`Unmocked import ${name} in ${path}`);
    };
    new Function("require", "module", "exports", "__DEV__", code)(
      require,
      module,
      module.exports,
      true,
    );
    return module.exports;
  }
  return load(resolve(file));
}
