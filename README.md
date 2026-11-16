# Col360

## Servidor local del agente

1. Instala las dependencias del proyecto con `npm install`.
2. Copia `.env.example` a `.env` y completa `GROQ_API_KEY`. `API_SECRET_TOKEN` y el antiguo `COL360_AGENT_TOKEN` también se aceptan como Bearer adicionales. El modelo se detecta automáticamente; configura `GROQ_MODEL` solo si quieres sobrescribirlo.
3. Instala Chromium para Playwright una vez con `npx playwright install chromium`.
4. Inicia el servicio con `node server.js`. Por defecto escucha solo en `127.0.0.1:3000`; `PORT` cambia el puerto.
5. Si usas un túnel HTTPS, abre Col360 con `?server=https://tu-tunel` para guardarlo automáticamente en `localStorage`. También puedes configurar la URL haciendo doble clic en el indicador de estado. Sin URL configurada, el servidor aparece apagado. El cliente consulta `/health` cada 15 segundos.

El navegador usa automáticamente el Bearer guardado en `localStorage` (`col360-server-token`) o el token de demostración `col360-demo-2026`; no solicita una clave al usuario. Las rutas del agente siguen respondiendo `401` si falta un Bearer válido. El token de demostración está incluido en el HTML público, por lo que no debe considerarse un secreto ni una protección suficiente para un túnel expuesto; para protegerlo realmente, no publiques un token compartido en el cliente. No es la clave de Groq. CORS permite los orígenes Col360 configurados en `server.js`.

El agente solo admite estas consultas oficiales: comparendos SIMIT, afiliación ADRES, antecedentes fiscales de Contraloría y antecedentes disciplinarios de Procuraduría. Chrome deja cualquier CAPTCHA para que lo resuelva la persona; la consulta solo se envía al pulsar **Aceptar y enviar**. La referencia `COL360-…` es local, no un radicado emitido por la entidad.

Si el servidor está apagado, el chat ofrece notificar por ntfy.sh. El tema configurado es público; el formulario lo advierte y pide consentimiento antes de enviar el nombre y el trámite.

`GET /` y `GET /health` informan si el servidor está activo. La navegación se limita a las cuatro URLs exactas incluidas en `server.js`.