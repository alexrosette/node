import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';

import { readCoreVersion } from '@common/utils/read-core-version';

const execFileAsync = promisify(execFile);

export interface IXrayProcessStatus {
    up: boolean;
    pid: number | null;
    raw: string;
}

@Injectable()
export class XrayProcessService {
    private readonly logger = new Logger(XrayProcessService.name);

    private readonly serviceDir: string;
    private readonly controlFifo: string;

    private static readonly S6_SVC = '/command/s6-svc';
    private static readonly S6_SVSTAT = '/command/s6-svstat';
    private static readonly CORE_LINK = '/usr/local/bin/rw-core';

    private static readonly UP_TIMEOUT_MS = 10_000;

    constructor() {
        this.serviceDir = process.env.XRAY_S6_SERVICE_DIR ?? '/run/service/xray';
        this.controlFifo = `${this.serviceDir}/supervise/control`;
    }

    public isControlAvailable(): boolean {
        return existsSync(this.controlFifo);
    }

    /**
     * No deadline: a loaded core (thousands of connections) can take well over 10 s to exit,
     * and giving up halfway left the service "wanted down" with nobody starting it again.
     */
    public async stop(): Promise<void> {
        const startedAt = performance.now();

        await execFileAsync(XrayProcessService.S6_SVC, ['-wd', '-d', this.serviceDir]);

        const tookSec = (performance.now() - startedAt) / 1000;

        if (tookSec > 10) {
            this.logger.warn(`Xray Core took ${tookSec.toFixed(1)} s to exit.`);
        }
    }

    public async start(): Promise<void> {
        await execFileAsync(XrayProcessService.S6_SVC, [
            '-wu',
            '-T',
            String(XrayProcessService.UP_TIMEOUT_MS),
            '-o',
            this.serviceDir,
        ]);
    }

    public async getCoreVersion(): Promise<null | string> {
        try {
            return (await readCoreVersion(XrayProcessService.CORE_LINK)).semver;
        } catch (error) {
            this.logger.warn(`Failed to read xray core version: ${error}`);
            return null;
        }
    }

    public async getStatusLine(): Promise<string> {
        try {
            const { stdout } = await execFileAsync(XrayProcessService.S6_SVSTAT, [this.serviceDir]);

            return stdout.trim();
        } catch (error) {
            return `unavailable (${error instanceof Error ? error.message : String(error)})`;
        }
    }

    public async getStatus(): Promise<IXrayProcessStatus> {
        try {
            const { stdout } = await execFileAsync(XrayProcessService.S6_SVSTAT, [
                '-o',
                'up,pid',
                this.serviceDir,
            ]);

            const raw = stdout.trim();
            const [up, pid] = raw.split(/\s+/);
            const pidNum = Number(pid);

            return {
                up: up === 'true',
                pid: Number.isFinite(pidNum) && pidNum > 0 ? pidNum : null,
                raw,
            };
        } catch (error) {
            this.logger.warn(`Failed to read xray s6 status: ${error}`);
            return { up: false, pid: null, raw: '' };
        }
    }
}
