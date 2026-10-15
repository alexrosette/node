import prettyBytes from 'pretty-bytes';

import { INestApplication } from '@nestjs/common';

import { getPanels } from '@common/multi-panel';

import { XrayService } from '../../modules/xray-core/xray.service';
import { getSystemInfo } from './get-system-stats';
import { renderBox } from './render-box';

export async function getStartMessage(appPort: number, app: INestApplication) {
    const xrayService = app.get(XrayService);

    const xrayInfo = xrayService.getXrayInfo();
    const systemInfo = getSystemInfo();
    const panels = getPanels();

    return renderBox(`Remnawave Node v${__RWNODE_VERSION__}`, [
        'Docs → https://docs.rw\nCommunity → https://t.me/remnawave',
        panels.length > 1
            ? `Multi-panel mode: ${panels.length} panels\n` +
              panels
                  .map(
                      (panel) =>
                          `  ${panel.label} → port ${panel.port}${panels.filter((p) => p.port === panel.port).length > 1 ? ' (shared, SNI)' : ''}`,
                  )
                  .join('\n')
            : `API Port: ${appPort}`,
        `XRay Core: v${xrayInfo.version || 'N/A'}\nXRay Path: /usr/local/bin/xray`,
        `${systemInfo.cpus}C, ${systemInfo.cpuModel}, ${prettyBytes(systemInfo.memoryTotal)}`,
        `Kernel: ${systemInfo.release} ${systemInfo.type} ${systemInfo.platform}`,
        `Network Interfaces: ${systemInfo.networkInterfaces.join(', ')}`,
    ]);
}
