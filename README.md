# Col360

## Servidor local del agente

1. Instala las dependencias del proyecto con `npm install`.
2. Copia `.env.example` a `.env` y completa `GROQ_API_KEY`. Define también un valor largo y aleatorio para `COL360_AGENT_TOKEN` (puedes generarlo con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). El modelo se detecta automáticamente; configura `GROQ_MODEL` solo si quieres sobrescribirlo.
3. Instala Chromium para Playwright una vez con `npx playwright install chromium`.
4. Inicia el servicio con `node server.js`. Por defecto escucha solo en `127.0.0.1:3000`; `PORT` cambia el puerto.
5. Si usas un túnel HTTPS, abre Col360 con `?server=https://tu-tunel` para guardarlo automáticamente en `localStorage`. También puedes configurar la URL haciendo doble clic en el indicador de estado. Sin URL configurada, el servidor aparece apagado. El cliente consulta `/health` cada 15 segundos.

Las rutas del agente siguen protegidas por `COL360_AGENT_TOKEN`; el navegador lo solicita al usar el agente y lo guarda solo en la sesión. No es la clave de Groq. El indicador de estado no necesita token. CORS permite los orígenes Col360 y los puertos locales configurados en `server.js`.

El agente solo admite estas consultas oficiales: comparendos SIMIT, afiliación ADRES, antecedentes fiscales de Contraloría y antecedentes disciplinarios de Procuraduría. Chrome deja cualquier CAPTCHA para que lo resuelva la persona; la consulta solo se envía al pulsar **Aceptar y enviar**. La referencia `COL360-…` es local, no un radicado emitido por la entidad.

Si el servidor está apagado, el chat ofrece notificar por ntfy.sh. El tema configurado es público; el formulario lo advierte y pide consentimiento antes de enviar el nombre y el trámite.

`GET /` y `GET /health` informan si el servidor está activo. La navegación se limita a las cuatro URLs exactas incluidas en `server.js`.