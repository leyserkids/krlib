#!/usr/bin/env node
const path = require('path');
const semver = require('semver');
const { existsSync, writeFile } = require('fs');
const { spawn, execSync, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const writeFileAsync = promisify(writeFile);

let Constant = {
    get COMPONENT_PKG_FILE() {
        return 'package.json';
    },
    get KR_LIB_PKG_FILE() {
        return 'node_modules/kr-library/package.json';
    },
    get MINIMUM_NPM_VERSION() {
        // Ref:
        // https://github.com/npm/npm/issues/17929#issuecomment-367924287
        // https://github.com/npm/npm/issues/17379#issuecomment-367924115
        return '5.7.1';
    },
    get ENVIRONMENT_CONFIG_FILE() {
        return 'krlib.config.json';
    },
};

class Environment {
    constructor(rootPath) {
        const configFile = path.resolve(rootPath, Constant.ENVIRONMENT_CONFIG_FILE);
        this.config = require(configFile);
    }

    get COMPONENT_DIRECTORIES() {
        return Object.freeze(this.config.component);
    }

    get KR_LIB_URL() {
        return this.config.url;
    }

    get KR_LIB_NPM_URL() {
        return `git+${this.KR_LIB_URL}#semver:`;
    }
}

class Utils {
    /**
     * get root directory of current git repo
     * @returns {String} path
     */
    static getGitRootDirectorySync() {
        let rawPath = [];

        try {
            const cmd = execSync('git rev-parse --show-toplevel');
            rawPath = cmd.toString().split('\n')[0];
        } catch (err) {
            Utils.loggerError(err);
            throw new Error('Could not get root directory from git');
        }

        return path.resolve(rawPath);
    }

    /**
     * get user email of current git repo
     * @returns {String} email
     */
    static async getGitUserAsync() {
        let email = '';

        try {
            const cmd = await execAsync('git config user.email');
            email = cmd.stdout.split('\n')[0];
        } catch (unused) { }

        return email;
    }

    /**
     * get name of current git repo
     * @returns {String} repo name
     */
    static async checkLeyserkidsRepositoryAsync() {
        let check = false;

        try {
            const cmd = await execAsync('git remote get-url --push origin');
            const name = cmd.stdout.split('\n')[0];
            check = /gcleyser\//.test(name);
        } catch (err) {
            Utils.loggerError(err);
            throw new Error('Could not get repository name from git');
        }
        return check;
    }

    static async getLatestVersionAsync() {
        let version = '';

        try {
            const cmd = await execAsync(`git ls-remote --tags --refs ${Constant.KR_LIB_URL}`);
            const tags = cmd.stdout
                .match(/refs\/tags\/v[0-9]*\.[0-9]*\.[0-9]*/g)
                .map((v) => v.replace('refs/tags/v', ''));
            version = semver.maxSatisfying(tags, '*');
        } catch (err) {
            Utils.loggerError(err);
            throw new Error('Could not obtain latest version number from remote git');
        }

        return version;
    }

    static getCliVersion() {
        let version;
        try {
            const config = require(path.join(__dirname, '../package.json'));
            if (config) {
                version = config.version;
            }
        } catch (err) {
            Utils.loggerError(err);
            throw new Error(`Failed to detect current version of the globally installed kr-library`);
        }
        return version;
    }

    static async getNpmVersionAsync() {
        let version = '';

        try {
            const cmd = await execAsync('npm --version');
            version = cmd.stdout.split('\n')[0];
        } catch (err) {
            Utils.loggerError(err);
            throw new Error('Could not get npm version, please make sure npm has been installed');
        }

        return version;
    }

    static updateCli(root) {
        const child = spawn('node', ['install.js'], {
            stdio : 'ignore',
            shell : true,
            detached : true,
            cwd : path.join(root, 'tools/kr-library'),
        });
        child.unref();
        process.exit();
    }

    static _logger(message) {
        process.stdout.write(`${message}\n`);
    }

    static loggerSuccess(message) {
        this._logger(`\x1b[32m${message}\x1b[0m`);
    }

    static loggerError(message) {
        process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
    }

    static loggerWarning(message) {
        this._logger(`\x1b[33m${message}\x1b[0m`);
    }

    static loggerInfo(message) {
        this._logger(message);
    }
}

class PackageInstaller {
    constructor(installPath = '.') {
        this.installPath = installPath;
    }

    _installPackage(paramArray) {
        return new Promise((resolve) => {
            const child = spawn(
                /^win/.test(process.platform) ? 'npm.cmd' : 'npm',
                paramArray,
                { cwd : this.installPath },
            );

            child.stdout.on('data', (data) => {
                Utils.loggerInfo(data.toString());
            });

            child.stderr.on('data', (data) => {
                const dataStr = data.toString();
                if (!dataStr.includes('npm update check failed')) {
                    Utils.loggerError(dataStr);
                }
            });

            child.on('close', (code) => {
                resolve(code);
            });
        });
    }

    async installComponently() {
        Utils.loggerInfo(`Please wait, Running 'npm install' at ${this.installPath} . . .`);
        let code = await this._installPackage(['install']);
        if (code === 0) {
            Utils.loggerSuccess(`Run 'npm install' at [${this.installPath}] successfully`);
        } else {
            Utils.loggerError(`Failed to run 'npm install' at [${this.installPath}] with code: ${code}`);
        }
    }

    async installSpecificVersionAsync(version) {
        Utils.loggerInfo(`Please wait, installing kr-library(${version}) into ${this.installPath} . . .`);
        let code = await this._installPackage(['install', Constant.KR_LIB_NPM_URL + version]);
        if (code === 0) {
            Utils.loggerSuccess(`Install kr-library into ${this.installPath} successfully`);
        } else {
            Utils.loggerError(`Failed install kr-library at ${this.installPath} with code: ${code}`);
        }
    }
}

class Component {
    constructor(componentName, componentPath) {
        this.componentName = componentName;
        this.componentPath = componentPath;
        this.packageJson = path.join(this.componentPath, Constant.COMPONENT_PKG_FILE);
        this.krLibraryPackageJson = path.join(this.componentPath, Constant.KR_LIB_PKG_FILE);
        this.installer = new PackageInstaller(this.componentPath);
    }

    initialize() {
        this.exist = this._checkExist();
        this.currentVersion = this._getCurrentVersion();
        this.expectedVersion = this._getExpectedVersion();
        return this;
    }

    _checkExist() {
        return existsSync(this.krLibraryPackageJson);
    }

    _getCurrentVersion() {
        let version = '';
        if (!this._checkExist()) {
            return version;
        }
        try {
            version = require(this.krLibraryPackageJson).version;
        } catch (err) {
            Utils.loggerError(err);
            throw new Error(`Could load ${this.krLibraryPackageJson}, please make the file vailed`);
        }
        return version;
    }

    _getExpectedVersion() {
        let version = '';
        try {
            const pkg = require(this.packageJson);
            const npmUrl = pkg.dependencies['kr-library'];
            if (npmUrl) {
                version = npmUrl.match(/#semver:[0-9]*\.[0-9]*\.[0-9]*/g)[0].replace('#semver:', '');
            }
        } catch (err) {
            Utils.loggerError(err);
            throw new Error(`Could load ${this.packageJson}, please make the file vailed`);
        }
        return version;
    }

    compareVersion() {
        if (!this._checkExist()) {
            return -2;
        }
        return semver.compare(this.currentVersion, this.expectedVersion);
    }

    async setVersionAsync(version) {
        let pkg = require(this.packageJson);
        pkg.dependencies['kr-library'] = Constant.KR_LIB_NPM_URL + version;
        await writeFileAsync(this.packageJson, JSON.stringify(pkg, null, 2), { encoding : 'utf8' });
    }
}

class LeyserkidsComponentCollection {
    constructor(root, latestVersion) {
        this.root = root;
        this.components = this._initComponents();
        this.latestVersion = latestVersion;
    }

    find(componentName) {
        return this.components.find(component => component.componentName === componentName);
    }

    getUnInstalled() {
        return this.components.filter(component => !component.exist);
    }

    getUnExpected() {
        return this.components.filter(component => semver.lt(component.currentVersion, component.expectedVersion));
    }

    getUnLatested() {
        return this.components.filter(component => semver.lt(component.expectedVersion, this.latestVersion));
    }

    _initComponents() {
        let components = [];
        const componentsConfig = Constant.COMPONENT_DIRECTORIES;
        for (const key in componentsConfig) {
            if (componentsConfig.hasOwnProperty(key)) {
                components.push(new Component(key, path.join(this.root, componentsConfig[key])).initialize());
            }
        }
        return components;
    }

    async installPackagesAsync(componentArray) {
        const asyncInstallFuncs = componentArray.map((component, index) => () =>
            new Promise((resolve, reject) => {
                setTimeout(async () => {
                    await component.installer.installComponently().catch((err) => reject(err));
                    resolve();
                }, index * 500);
            }),
        );
        await Promise.all(asyncInstallFuncs.map((func) => func()));
    }

    async installPackagesWithVersionAsync(componentArray, versionFinderFunc) {
        const asyncInstallFuncs = componentArray.map((component, index) => () =>
            new Promise((resolve, reject) => {
                setTimeout(async () => {
                    await component.installer.installSpecificVersionAsync(versionFinderFunc(component)).catch((err) => reject(err));
                    resolve();
                }, index * 500);
            }),
        );
        await Promise.all(asyncInstallFuncs.map((func) => func()));
    }

    async installLatestAsync(componentArray) {
        await this.installPackagesWithVersionAsync(componentArray, () => this.latestVersion);
    }

    async installExpectAsync(componentArray) {
        await this.installPackagesWithVersionAsync(componentArray, (component) => component.expectedVersion);
    }

    static checkVersion(componentName) {
        // eslint-disable-next-line no-sync
        const instance = new LeyserkidsComponentCollection(Utils.getGitRootDirectorySync());
        return instance.find(componentName).compareVersion();
    }

    static checkVersionWithAssert(componentName) {
        if (LeyserkidsComponentCollection.checkVersion(componentName) < 0) {
            Utils.loggerError('Oops, The kr-library is outdated, Please run `krlib` to update');
            process.exit(1);
        }
    }
}

class TableBuilder {
    constructor() {
        this.HEADER_NAME = ['Module', 'Installed', 'Expected', 'Latest'];
        this.header = [];
        this.margin = '\u0020\u0020\u0020\u0020';
    }

    build() {
        this._computeLayout();
        const bodyStr = this.data.reduce((accRow, curRow, idx) => {
            let insert = '\n';
            if (idx === 0) {
                insert = '';
            } else if (idx === 1) {
                insert = `\n${this.line}\n`;
            }
            accRow = accRow + insert + Object.values(curRow).sort((ra, rb) => ra.col - rb.col).map(col => col.str).reduce((accCol, curCol) => {
                accCol = accCol + curCol;
                return accCol;
            });
            return accRow;
        }, '');

        return bodyStr;
    }

    _computeLayout() {
        this.data.unshift({
            componentName : {
                rawStr : this.HEADER_NAME[0],
                length : this.HEADER_NAME[0].length,
                col : 0,
            },
            currentVersion : {
                rawStr : this.HEADER_NAME[1],
                length : this.HEADER_NAME[1].length,
                col : 1,
            },
            expectedVersion : {
                rawStr : this.HEADER_NAME[2],
                length : this.HEADER_NAME[2].length,
                col : 2,
            },
            latestVersion : {
                rawStr : this.HEADER_NAME[3],
                length : this.HEADER_NAME[3].length,
                col : 3,
            },
        });
        const cols = this.data.reduce((acc, cur) => {
            const col = Object.values(cur).sort((ra, rb) => ra.col - rb.col).map(row => row.length);
            for (let i = 0; i < acc.length; i++) {
                acc[i] = col[i] > acc[i] ? col[i] : acc[i];
            }
            return acc;
        }, [0, 0, 0, 0]);
        this.data.forEach(row => {
            const col = Object.values(row).sort((ra, rb) => ra.col - rb.col);
            for (let i = 0; i < cols.length; i++) {
                col[i].str = col[i].rawStr.padEnd(cols[i], '\u0020') + this.margin;
            }
        });
        this.width = cols.reduce((acc, cur) => {
            acc = acc + cur;
            return acc;
        }) + (this.HEADER_NAME.length - 1) * this.margin.length;
        this.line = new Array(this.width).fill('-').join('');
    }

    readSourceDate(pkgs) {
        this.data = pkgs.components.map(component => {
            const { componentName, currentVersion, expectedVersion } = component;
            const latestVersion = pkgs.latestVersion;
            return {
                componentName : {
                    rawStr : componentName,
                    length : componentName.length,
                    col : 0,
                },
                currentVersion : {
                    rawStr : currentVersion,
                    length : currentVersion.length,
                    col : 1,
                },
                expectedVersion : {
                    rawStr : expectedVersion,
                    length : expectedVersion.length,
                    col : 2,
                },
                latestVersion : {
                    rawStr : latestVersion,
                    length : latestVersion.length,
                    col : 3,
                },
            };
        });
    }
}

class Cli {
    showLogo() {
        // prettier-ignore
        const LOGO = '' +
            '    __ __         __    _ __                         \n' +
            '   / //_/_____   / /   (_) /_  _________ ________  __\n' +
            '  / ,<  / ___/  / /   / / __ \\/ ___/ __ `/ ___/ / / /\n' +
            ' / /| |/ /     / /___/ / /_/ / /  / /_/ / /  / /_/ / \n' +
            '/_/ |_/_/     /_____/_/_.___/_/   \\__,_/_/   \\__, /  \n' +
            '                                            /____/   \n';
        Utils.loggerInfo(LOGO);
    }

    getUserInputAsync(expectedInputs) {
        const matcher = new RegExp(`[${expectedInputs.join('|')}]`, 'g');
        return new Promise((resolve) => {
            let stdin = process.stdin;
            stdin.resume();
            stdin.setEncoding('utf-8');
            stdin.on('data', (data) => {
                const matche = data.match(matcher);
                if (matche && matche.length === 1) {
                    resolve(matche[0]);
                    stdin.pause();
                } else {
                    Utils.loggerWarning('Invalied input');
                }
            });
        });
    }

    async checkInstall() {
        const exist = await this.krLibrary.checkFullyInstalledAsync();
        if (!exist) {
            const UNINSTALLED =
                'The kr-library has never been installed, \nPlease type y to confirm install the expected kr-library';
            Utils.loggerError(UNINSTALLED);
        }
        return exist;
    }

    async checkEnvironmentAsync() {
        if (!(await Utils.checkLeyserkidsRepositoryAsync())) {
            Utils.loggerError(`Please run this command in leyserkids directory!`);
            process.exit(1);
        }
    }

    async obtainLatestVersionAsync() {
        Utils.loggerInfo('Obtaining the version number . . .');
        const version = await Utils.getLatestVersionAsync();
        Utils.loggerSuccess(`The latest kr-library is ${version}`);
        return version;
    }

    async checkCliVersionAsync(latestVersion) {
        const cliVersion = await Utils.getCliVersion();
        if (semver.lt(cliVersion, latestVersion)) {
            Utils.loggerWarning(`Caution! The globally installed krlib cli is outdated. \nIt is highly recommended to update krlib cli.\n\nType [y] to confirm update or [n] to ignore`);
            const ipt = await this.getUserInputAsync(['y', 'n']);
            if (ipt === 'y') {
                Utils.loggerInfo('Current command will exit to updating, Please wait a moment and rerun or follow the message if available');
                Utils.updateCli(this.rootPath);
            }
        }
    }

    showInstalledStatus(pkgs) {
        Utils.loggerInfo('\nOverview\n========');
        const tableBuilder = new TableBuilder();
        tableBuilder.readSourceDate(pkgs);
        const table = tableBuilder.build();
        Utils.loggerInfo(table);
    }

    async checkFullyInstalled() {
        const unInstalled = this.pkgs.getUnInstalled();
        if (unInstalled.length > 0) {
            Utils.loggerError('\nOops, The kr-library is not fully installed, \n\nType [y] to confirm install or [n] to exit');
            const ipt = await this.getUserInputAsync(['y', ['n']]);
            if (ipt === 'y') {
                await this.pkgs.installExpectAsync(unInstalled);
                process.exit(0);
            } else {
                process.exit(0);
            }
        }
    }

    async checkExpectedVersion() {
        const unExpected = this.pkgs.getUnExpected();
        if (unExpected.length > 0) {
            Utils.loggerError('\nOops, The kr-library is outdated, \n\nType [y] to confirm install or [n] to ignore');
            const ipt = await this.getUserInputAsync(['y', ['n']]);
            if (ipt === 'y') {
                await this.pkgs.installExpectAsync(unExpected);
                process.exit(0);
            }
        }
    }

    async checkLatestVersion() {
        const unLatested = this.pkgs.getUnLatested();
        if (unLatested.length > 0) {
            Utils.loggerWarning('\nThe latest version kr-library is available, \n\nType [y] to confirm update to latest or [n] to ignore');
            const ipt = await this.getUserInputAsync(['y', ['n']]);
            if (ipt === 'y') {
                await this.pkgs.installLatestAsync(unLatested);
                process.exit(0);
            }
        }
    }

    async checkNPMVersion() {
        const npmVersion = await Utils.getNpmVersionAsync();
        if (semver.lt(npmVersion, Constant.MINIMUM_NPM_VERSION)) {
            Utils.loggerError(`Oops! The npm version is too low. \n\nPlease update npm (gte 5.7.1)`);
            process.exit(1);
        }
    }

    async run() {
        try {
            this.showLogo();
            await this.checkEnvironmentAsync();
            await this.checkNPMVersion();
            // eslint-disable-next-line no-sync
            this.rootPath = Utils.getGitRootDirectorySync();
            Constant = Object.assign(new Environment(this.rootPath), Constant);
            const latestVersion = await this.obtainLatestVersionAsync();
            // await this.checkCliVersionAsync(latestVersion);
            this.pkgs = new LeyserkidsComponentCollection(this.rootPath, latestVersion);
            this.showInstalledStatus(this.pkgs);
            await this.checkFullyInstalled();
            await this.checkExpectedVersion();
            await this.checkLatestVersion();

        } catch (err) {
            Utils.loggerError(`Failed to run krlib, err: ${err.message} \r\n ${err.stack}`);
            process.exit(1);
        }
    }
}

if (typeof require !== 'undefined' && require.main === module) {
    new Cli().run();
}

module.exports = LeyserkidsComponentCollection;
