# Col360

## Servidor local del agente

1. Instala las dependencias del proyecto con `npm install`.
2. Copia `.env.example` a `.env` y completa `GROQ_API_KEY`. Define también un valor largo y aleatorio para `COL360_AGENT_TOKEN` (puedes generarlo con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). El modelo se detecta automáticamente; configura `GROQ_MODEL` solo si quieres sobrescribirlo.
3. Instala Chromium para Playwright una vez con `npx playwright install chromium`.
4. Inicia el servicio con `node server.js`. Por defecto escucha solo en `127.0.0.1:3000`; `TARGET_URL` puede cambiar el formulario y `PORT` el puerto.
5. En Col360 pulsa **🔌 Servidor PC** y pega la URL del servidor/túnel y el mismo token. El token protege las rutas del agente; no es la clave de Groq.

Groq recibe los mensajes y el contexto enviados desde el servidor. El agente deja el formulario abierto para revisión y solo lo envía al portal externo después de pulsar **Aceptar y enviar**. La referencia `COL360-…` que guarda en Mis Citas es local, no un radicado emitido por la entidad.