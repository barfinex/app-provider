export interface ILPWriteOptions {
    table: string;

    /** Tag columns */
    keys?: Record<string, string | number>;

    /** Field columns */
    fields?: Record<string, string | number | boolean | null>;

    /** Timestamp в наносекундах */
    timestamp?: number;
}
