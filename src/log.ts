// Plain-text log lines on stdout; launchd sends them to
// ~/Library/Logs/connectors.log. Never pass a token, OAuth secret, tool
// arguments or the ntfy topic to these functions.

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

/**
 * One line per message: control characters (a newline in a JSON-RPC method
 * name, say) are escaped so nothing an agent sends can forge a log line.
 */
export function oneLine(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code === 10) return "\\n";
    if (code === 13) return "\\r";
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function line(level: string, message: string): string {
  return `${new Date().toISOString()} ${level} ${oneLine(message)}\n`;
}

export const consoleLogger: Logger = {
  info: (message) => process.stdout.write(line("info", message)),
  warn: (message) => process.stdout.write(line("warn", message)),
  error: (message) => process.stdout.write(line("error", message)),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Collects lines in memory, for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${oneLine(message)}`),
    warn: (message) => lines.push(`warn ${oneLine(message)}`),
    error: (message) => lines.push(`error ${oneLine(message)}`),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
