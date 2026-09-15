const vscode = require('vscode');
const { execSync } = require('child_process');
const https = require('https');

let statusBarItem;
let quotaTimer;
let cachedConnection = null;
let lastQuotaData = null;

function activate(context) {
    // 1. Crear el ítem en la barra de estado
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-quota.showDetails';
    context.subscriptions.push(statusBarItem);

    // 2. Registrar comando para refrescar manualmente
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-quota.refresh', async () => {
            statusBarItem.text = '$(sync~spin) Gemini: Actualizando...';
            await updateQuotaStatusBar(true);
            vscode.window.showInformationMessage('Cuota de Antigravity actualizada.');
        })
    );

    // 3. Registrar comando para mostrar modal / QuickPick con detalles completos
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-quota.showDetails', async () => {
            await showQuotaQuickPick();
        })
    );

    // 4. Escuchar cambios de configuración
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('antigravityQuota')) {
                setupTimer();
                updateQuotaStatusBar();
            }
        })
    );

    // 5. Inicializar y configurar temporizador
    setupTimer();
    updateQuotaStatusBar();
}

function setupTimer() {
    if (quotaTimer) {
        clearInterval(quotaTimer);
    }
    const config = vscode.workspace.getConfiguration('antigravityQuota');
    const intervalSec = Math.max(15, config.get('refreshIntervalSeconds', 300));
    quotaTimer = setInterval(() => {
        updateQuotaStatusBar();
    }, intervalSec * 1000);
}

/**
 * Escanea procesos locales en busca del Language Server de Antigravity
 */
function findLanguageServerProcesses() {
    try {
        const psOut = execSync('ps aux', { encoding: 'utf8' });
        const list = [];
        for (const line of psOut.split('\n')) {
            if (line.includes('language_server_') && line.includes('--csrf_token')) {
                const csrfMatch = line.match(/--csrf_token\s+([^\s]+)/);
                const parts = line.trim().split(/\s+/);
                if (csrfMatch && parts.length > 1) {
                    list.push({ pid: parts[1], csrf: csrfMatch[1] });
                }
            }
        }
        return list;
    } catch (err) {
        console.error('[Antigravity Quota] Error running ps:', err);
        return [];
    }
}

/**
 * Obtiene los puertos TCP en escucha de un proceso mediante lsof
 */
function getListeningPorts(pid) {
    try {
        const lsofOut = execSync(`lsof -a -p ${pid} -i4TCP -sTCP:LISTEN`, { encoding: 'utf8' });
        const ports = [];
        for (const match of lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
            ports.push(match[1]);
        }
        return ports;
    } catch (err) {
        return [];
    }
}

/**
 * Llama al endpoint gRPC-Web / Connect-Protocol de LanguageServerService para obtener la cuota
 */
function requestQuota(port, csrfToken) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({});
        const req = https.request({
            hostname: '127.0.0.1',
            port: Number(port),
            path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': csrfToken,
                'Content-Length': Buffer.byteLength(payload)
            },
            rejectUnauthorized: false,
            timeout: 2500
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Localiza la conexión activa con el Language Server y extrae los datos de cuota
 */
async function fetchQuotaFromLanguageServer(forceRediscover = false) {
    // Si tenemos una conexión en caché y no forzamos redescrubrimiento, intentamos primero con esa
    if (!forceRediscover && cachedConnection) {
        try {
            const data = await requestQuota(cachedConnection.port, cachedConnection.csrf);
            return data?.response || null;
        } catch (e) {
            // Si falló, invalidamos la conexión en caché y procedemos a buscar de nuevo
            cachedConnection = null;
        }
    }

    const procs = findLanguageServerProcesses();
    for (const proc of procs) {
        const ports = getListeningPorts(proc.pid);
        for (const port of ports) {
            try {
                const data = await requestQuota(port, proc.csrf);
                if (data?.response) {
                    cachedConnection = { port, csrf: proc.csrf, pid: proc.pid };
                    return data.response;
                }
            } catch (e) {
                // Probar siguiente puerto
            }
        }
    }

    return null;
}

/**
 * Actualiza el indicador en la barra de estado
 */
async function updateQuotaStatusBar(forceRediscover = false) {
    try {
        const quotaResponse = await fetchQuotaFromLanguageServer(forceRediscover);
        if (!quotaResponse || !quotaResponse.groups) {
            statusBarItem.text = '$(warning) Gemini Quota: Desconectado';
            statusBarItem.tooltip = 'No se encontró una instancia activa del Language Server de Antigravity.';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.show();
            return;
        }

        lastQuotaData = quotaResponse;

        // Buscar grupo Gemini
        const geminiGroup = quotaResponse.groups.find(g => 
            (g.displayName && g.displayName.toLowerCase().includes('gemini'))
        ) || quotaResponse.groups[0];

        // Buscar bucket semanal y de 5 horas
        const weeklyBucket = geminiGroup?.buckets?.find(b => 
            b.window === 'weekly' || (b.displayName && b.displayName.toLowerCase().includes('weekly'))
        );
        const fiveHourBucket = geminiGroup?.buckets?.find(b => 
            b.window === '5h' || (b.displayName && b.displayName.toLowerCase().includes('five hour'))
        );

        const weeklyPct = weeklyBucket && typeof weeklyBucket.remainingFraction === 'number'
            ? Math.round(weeklyBucket.remainingFraction * 100)
            : null;

        const fiveHourPct = fiveHourBucket && typeof fiveHourBucket.remainingFraction === 'number'
            ? Math.round(fiveHourBucket.remainingFraction * 100)
            : null;

        // Color y advertencia según umbral configurado (por defecto 20%)
        const config = vscode.workspace.getConfiguration('antigravityQuota');
        const threshold = config.get('lowQuotaThreshold', 20);

        const minPct = Math.min(
            weeklyPct !== null ? weeklyPct : 100,
            fiveHourPct !== null ? fiveHourPct : 100
        );
        const isLow = minPct < threshold;

        // Formatear texto para la barra de estado
        const icon = isLow ? '$(alert)' : '$(hubot)';
        if (weeklyPct !== null && fiveHourPct !== null) {
            statusBarItem.text = `${icon} Gemini: ${weeklyPct}% (5h: ${fiveHourPct}%)`;
        } else if (weeklyPct !== null) {
            statusBarItem.text = `${icon} Gemini: ${weeklyPct}%`;
        } else {
            statusBarItem.text = `${icon} Gemini: Activo`;
        }

        // Construir Tooltip enriquecido en Markdown
        const tooltip = new vscode.MarkdownString();
        tooltip.isTrusted = true;
        tooltip.supportThemeIcons = true;
        tooltip.appendMarkdown(`### Estado de Cuota de Antigravity (Gemini)\n\n`);

        for (const group of quotaResponse.groups) {
            tooltip.appendMarkdown(`**${group.displayName}**\n`);
            for (const bucket of (group.buckets || [])) {
                const pct = typeof bucket.remainingFraction === 'number'
                    ? `${Math.round(bucket.remainingFraction * 100)}%`
                    : 'N/A';
                const desc = bucket.description ? `  \n_${bucket.description}_` : '';
                tooltip.appendMarkdown(`- **${bucket.displayName}:** \`${pct}\`${desc}\n`);
            }
            tooltip.appendMarkdown(`\n---\n`);
        }
        tooltip.appendMarkdown(`[$(refresh) Actualizar Cuota](command:antigravity-quota.refresh) | [$(info) Ver Detalles](command:antigravity-quota.showDetails)`);
        statusBarItem.tooltip = tooltip;

        // Color de fondo y texto rojo cuando la cuota está por debajo del 20%
        if (isLow) {
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        } else {
            statusBarItem.backgroundColor = undefined;
            statusBarItem.color = undefined;
        }

        statusBarItem.show();
    } catch (err) {
        console.error('[Antigravity Quota] Error updating status bar:', err);
        statusBarItem.text = '$(warning) Gemini Quota: Error';
        statusBarItem.tooltip = `Error al consultar cuota: ${err.message}`;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.show();
    }
}

/**
 * Despliega menú interactivo QuickPick con toda la información detallada
 */
async function showQuotaQuickPick() {
    if (!lastQuotaData) {
        await updateQuotaStatusBar(true);
    }

    if (!lastQuotaData || !lastQuotaData.groups) {
        vscode.window.showWarningMessage('No se pudo obtener información de cuotas de Antigravity.');
        return;
    }

    const items = [];

    for (const group of lastQuotaData.groups) {
        items.push({
            label: group.displayName,
            kind: vscode.QuickPickItemKind.Separator
        });

        for (const bucket of (group.buckets || [])) {
            const pct = typeof bucket.remainingFraction === 'number'
                ? `${Math.round(bucket.remainingFraction * 100)}%`
                : 'N/A';
            
            let icon = '$(check)';
            if (typeof bucket.remainingFraction === 'number') {
                if (bucket.remainingFraction < 0.20) {
                    icon = '$(error)';
                } else if (bucket.remainingFraction < 0.50) {
                    icon = '$(warning)';
                }
            }

            let detail = bucket.description || '';
            if (bucket.resetTime) {
                try {
                    const date = new Date(bucket.resetTime);
                    detail += (detail ? ' | ' : '') + `Reinicio: ${date.toLocaleString()}`;
                } catch (e) {}
            }

            items.push({
                label: `${icon} ${bucket.displayName}: ${pct}`,
                description: `(${bucket.window || 'límite'})`,
                detail: detail
            });
        }
    }

    items.push({
        label: 'Acciones',
        kind: vscode.QuickPickItemKind.Separator
    });

    items.push({
        label: '$(refresh) Actualizar Ahora',
        description: 'Forzar una actualización inmediata de cuotas',
        action: 'refresh'
    });

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Antigravity - Estado de Cuotas Gemini y Modelos',
        placeHolder: 'Selecciona una acción o presiona Escape para salir'
    });

    if (selected?.action === 'refresh') {
        await vscode.commands.executeCommand('antigravity-quota.refresh');
    }
}

function deactivate() {
    if (quotaTimer) {
        clearInterval(quotaTimer);
    }
}

module.exports = {
    activate,
    deactivate
};
