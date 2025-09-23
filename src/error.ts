export enum ErrorEnvironment {
    Unknown,
    Genetic,
    History,
    Core,
    Provider,
    Detector,
    Inspector,
    Tester,
}

export class AppError extends Error {
    public env: ErrorEnvironment;

    constructor(env: ErrorEnvironment, msg: string) {
        super(`${AppError.getErrorMessage(env)} ${msg}`);
        this.env = env;
        this.name = 'AppError';

        // 🔑 фикс для правильного прототипа (иначе instanceof Error может не работать)
        Object.setPrototypeOf(this, new.target.prototype);
    }

    private static getErrorMessage(env: ErrorEnvironment) {
        switch (env) {
            case ErrorEnvironment.History:
                return 'History error:';
            case ErrorEnvironment.Core:
                return 'Core error:';
            case ErrorEnvironment.Genetic:
                return 'Genetic error:';
            case ErrorEnvironment.Tester:
                return 'Tester error:';
            case ErrorEnvironment.Provider:
                return 'Provider error:';
            case ErrorEnvironment.Detector:
                return 'Detector error:';
            case ErrorEnvironment.Inspector:
                return 'Inspector error:';
            default:
                return 'Unknown error:';
        }
    }
}
