// dev/e2e-diagnostics.mjs — route the host logger to stderr for harness runs.
//
// dsh's boot harness keeps logger output in memory (`levels: { default: 2 }`,
// collected for the startup audit) and never writes it to the terminal. A test
// therefore cannot see WHY a turn did not run. This plugin registers one extra
// exporter at debug level that writes every record as one line:
//
//   [host-log <iso> <level> <name>] <message>
//
// Loaded only by dev/e2e-mock.mjs through dev/e2e-diagnostics.patch.yml; never
// part of a shipped profile.

export const name = 'e2e-diagnostics';

export function apply(ctx) {
  ctx.logger.exporter({
    levels: { default: 3 },
    export: ({ ts, name, type, args }) => {
      const text = args
        .map((value) => {
          if (typeof value === 'string') return value;
          if (value instanceof Error) return value.stack ?? value.message;
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })
        .join(' ');
      process.stderr.write(`[host-log ${new Date(ts).toISOString()} ${type} ${name}] ${text}\n`);
    },
  });
}
