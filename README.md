# GraviMeter — Antigravity Quota Status

Extensión para **Antigravity IDE** que consulta y muestra en tiempo real en la barra de estado el porcentaje de tu cuota de Gemini (límite semanal y ventana de 5 horas), así como los límites para modelos de terceros (Claude / GPT).

---

## Características

- **Monitor en la barra de estado**: Muestra `$(hubot) Gemini: XX% (5h: YY%)` en la esquina inferior derecha.
- **Detección automática del Language Server**: Se conecta directamente al daemon local de Antigravity (`language_server_macos_arm`) autenticándose mediante el token CSRF activo por sesión.
- **Tooltip enriquecido**: Al pasar el ratón, visualiza el desglose completo de grupos (Gemini, Claude, GPT), porcentajes restantes y tiempo estimado de reseteo.
- **Menú interactivo QuickPick**: Al hacer clic en el ítem de la barra de estado se abre una vista detallada interactiva con indicadores visuales de estado.
- **Alerta de cuota baja**: Cambia el color de fondo si la cuota cae por debajo del umbral configurable (por defecto 20%).
- **Comandos**:
  - `Antigravity: Actualizar Cuota` (`antigravity-quota.refresh`)
  - `Antigravity: Ver Detalles de Cuota` (`antigravity-quota.showDetails`)

---

## Configuración

Puedes personalizar la extensión en los ajustes de Antigravity / VS Code (`settings.json`):

```json
{
  "antigravityQuota.refreshIntervalSeconds": 60,
  "antigravityQuota.lowQuotaThreshold": 20
}
```

---

## Empaquetado e Instalación

Para compilar e instalar en tu IDE:

```bash
# 1. Empaquetar VSIX
npx vsce package

# 2. Instalar en Antigravity IDE
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension gravimeter-antigravity-0.0.1.vsix --force
```
