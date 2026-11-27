/**
 * The parts of electron-installer-debian 4.0.0 and electron-installer-redhat 4.0.0 that
 * `maker-linux.ts` uses (the packages ship no types). Both export their installer class as
 * `Installer`, a subclass of electron-installer-common's `ElectronInstaller`; the members below
 * are read from those three packages' sources at the pinned versions.
 */
declare module 'electron-installer-debian' {
  export interface InstallerOptions {
    name: string;
    version: string;
    arch: string;
    logger: (message: string) => void;
    packagePaths?: string[];
    [key: string]: unknown;
  }
  export class Installer {
    constructor(data: Record<string, unknown>);
    options: InstallerOptions;
    stagingDir: string;
    /** `usr` (the package root's prefix, relative to `stagingDir`). */
    get baseAppDir(): string;
    /** Method names `createContents()` runs, in parallel. */
    get contentFunctions(): string[];
    generateDefaults(): Promise<unknown>;
    generateOptions(): unknown;
    createStagingDir(): Promise<unknown>;
    createContents(): Promise<unknown>;
    copyLinuxIcons(): Promise<unknown>;
    createDesktopFile(): Promise<unknown>;
    createPackage(): Promise<unknown>;
    movePackage(): Promise<unknown>;
  }
}

declare module 'electron-installer-redhat' {
  export interface InstallerOptions {
    name: string;
    version: string;
    revision: string | number;
    arch: string;
    description?: string;
    productDescription?: string;
    license?: string;
    homepage?: string;
    requires: string[];
    logger: (message: string) => void;
    packagePaths?: string[];
    [key: string]: unknown;
  }
  export class Installer {
    constructor(data: Record<string, unknown>);
    options: InstallerOptions;
    stagingDir: string;
    /** `BUILD/usr` (relative to `stagingDir`, which is rpmbuild's `_topdir`). */
    get baseAppDir(): string;
    get contentFunctions(): string[];
    /** `<stagingDir>/SPECS/<name>.spec`. */
    get specPath(): string;
    generateDefaults(): Promise<unknown>;
    generateOptions(): unknown;
    generateScripts(): Promise<unknown>;
    createStagingDir(): Promise<unknown>;
    createContents(): Promise<unknown>;
    copyLinuxIcons(): Promise<unknown>;
    createDesktopFile(): Promise<unknown>;
    createSpec(): Promise<unknown>;
    createPackage(): Promise<unknown>;
    movePackage(): Promise<unknown>;
  }
}
