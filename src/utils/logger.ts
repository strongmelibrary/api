/**
 * Logger utility for consistent logging with service tags and colors
 */

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  // Bright foreground colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// Service color mapping
const serviceColors: Record<string, string> = {
  YCL: colors.cyan,
  LW: colors.green,
  SERVER: colors.yellow,
  SEARCH: colors.magenta,
  DEFAULT: colors.white,
};

// Log level color mapping
const levelColors: Record<string, string> = {
  INFO: colors.brightWhite,
  WARN: colors.brightYellow,
  ERROR: colors.brightRed,
  DEBUG: colors.brightBlue,
};

/**
 * Logger class for consistent logging with service tags and colors
 */
export class Logger {
  private service: string;
  private serviceColor: string;

  /**
   * Create a new logger instance for a specific service
   * @param service Service name (e.g., 'YCL', 'LW', 'SERVER')
   */
  constructor(service: string) {
    this.service = service.toUpperCase();
    this.serviceColor = serviceColors[this.service] || serviceColors.DEFAULT;
  }

  /**
   * Format a log message with service tag and timestamp
   * @param level Log level
   * @param message Message to log
   * @param args Additional arguments
   * @returns Formatted log message
   */
  private format(level: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const levelColor = levelColors[level] || colors.white;

    // Format: [TIMESTAMP] [SERVICE] [LEVEL] message
    const formattedMessage = `${colors.brightWhite}[${timestamp}]${colors.reset} ${this.serviceColor}[${this.service}]${colors.reset} ${levelColor}[${level}]${colors.reset} ${message}`;

    // If there are additional arguments, format them as JSON
    if (args.length > 0) {
      const argsStr = args.map(arg => {
        if (arg instanceof Error) {
          return { message: arg.message, stack: arg.stack };
        }
        return arg;
      });
      return `${formattedMessage} ${JSON.stringify(argsStr, null, 0)}`;
    }

    return formattedMessage;
  }

  /**
   * Log an info message
   * @param message Message to log
   * @param args Additional arguments
   */
  info(message: string, ...args: any[]): void {
    console.log(this.format('INFO', message, ...args));
  }

  /**
   * Log a warning message
   * @param message Message to log
   * @param args Additional arguments
   */
  warn(message: string, ...args: any[]): void {
    console.warn(this.format('WARN', message, ...args));
  }

  /**
   * Log an error message
   * @param message Message to log
   * @param args Additional arguments
   */
  error(message: string, ...args: any[]): void {
    console.error(this.format('ERROR', message, ...args));
  }

  /**
   * Log a debug message
   * @param message Message to log
   * @param args Additional arguments
   */
  debug(message: string, ...args: any[]): void {
    console.debug(this.format('DEBUG', message, ...args));
  }
}

/**
 * Create logger instances for different services
 */
export const loggers = {
  ycl: new Logger('YCL'),
  lw: new Logger('LW'),
  server: new Logger('SERVER'),
  search: new Logger('SEARCH'),
};

/**
 * Create a new logger instance for a custom service
 * @param service Service name
 * @returns Logger instance
 */
export const createLogger = (service: string): Logger => {
  return new Logger(service);
};

export default loggers;