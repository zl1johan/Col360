# Col360

## Servidor local del agente

1. Instala las dependencias del proyecto con `npm install`.
2. Copia `.env.example` a `.env` y completa `GROQ_API_KEY`, `SMTP_USER` y `SMTP_PASS`. Opcionalmente configura `SMTP_HOST` y `SMTP_PORT`; por defecto se usa `smtp-relay.brevo.com:587`. `API_SECRET_TOKEN` y el antiguo `COL360_AGENT_TOKEN` también se aceptan como Bearer adicionales. El modelo se detecta automáticamente; configura `GROQ_MODEL` solo si quieres sobrescribirlo.
3. Instala Chromium para Playwright una vez con `npx playwright install chromium`.
4. Inicia el servicio con `node server.js`. Por defecto escucha solo en `127.0.0.1:3000`; `PORT` cambia el puerto.
5. Si usas un túnel HTTPS, abre Col360 con `?server=https://tu-tunel` para guardarlo automáticamente en `localStorage`. También puedes configurar la URL haciendo doble clic en el indicador de estado. Sin URL configurada, el servidor aparece apagado. El cliente consulta `/health` cada 15 segundos.

El navegador usa automáticamente el Bearer guardado en `localStorage` (`col360-server-token`) o el token de demostración `col360-demo-2026`; no solicita una clave al usuario. Las rutas del agente siguen respondiendo `401` si falta un Bearer válido. El token de demostración está incluido en el HTML público, por lo que no debe considerarse un secreto ni una protección suficiente para un túnel expuesto; para protegerlo realmente, no publiques un token compartido en el cliente. No es la clave de Groq. CORS permite los orígenes Col360 configurados en `server.js`.

Los perfiles y las consultas completadas se guardan en `db.json`; no incluyas ese archivo en repositorios públicos. Los datos personales se usan localmente para completar formularios y no se agregan al prompt enviado a Groq. El agente solo admite estas consultas oficiales: comparendos SIMIT, afiliación ADRES y antecedentes disciplinarios de Procuraduría. Chrome deja el CAPTCHA para que lo resuelva la persona; la consulta solo se envía al pulsar **Aceptar y enviar**. La referencia `COL360-…` es local, no un radicado emitido por la entidad.

Al iniciar sesión se envía un código OTP al correo. Si el servidor está apagado, el control Server puede enviar una notificación genérica por ntfy.sh; el tema configurado es público y no se envían datos personales en esa notificación.

`GET /` y `GET /health` informan si el servidor está activo. La navegación se limita a las tres URLs exactas incluidas en `server.js`.