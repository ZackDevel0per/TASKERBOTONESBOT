/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                    BANECO SERVICE                                     ║
 * ║  Integración con la API QR Simple del Banco Económico S.A.           ║
 * ║                                                                      ║
 * ║  Flujo:                                                              ║
 * ║  1. cifrar()     → usa el endpoint del banco para cifrar AES-256     ║
 * ║  2. obtenerToken() → POST /authenticate con password cifrado         ║
 * ║  3. generarQR()  → POST /generateQR → qrId + imagen base64 PNG      ║
 * ║  4. verificarEstado() → GET /statusQR/{id} → pagado/pendiente/error  ║
 * ║                                                                      ║
 * ║  Nota: el token vence cada 30 minutos — se solicita uno fresco en   ║
 * ║  cada operación para garantizar que nunca expire entre llamadas.     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import axios from "axios";

const BASE_URL_DEFAULT = "https://apimktdesa.baneco.com.bo/ApiGateway";

export interface BanecoQRGenerado {
  qrId: string;
  qrBase64: string;
  expiry: Date;
}

export type BanecoVerifStatus = "pagado" | "pendiente" | "error";

export class BanecoService {
  private readonly username: string;
  private readonly password: string;
  private readonly aesKey: string;
  private readonly cuenta: string;
  private readonly baseUrl: string;

  constructor(
    username: string,
    password: string,
    aesKey: string,
    cuenta: string,
    baseUrl = BASE_URL_DEFAULT,
  ) {
    this.username = username;
    this.password = password;
    this.aesKey = aesKey;
    this.cuenta = cuenta;
    this.baseUrl = baseUrl;
  }

  /**
   * Cifra un texto usando el endpoint de cifrado del propio banco.
   * El banco usa AES-256 y devuelve el resultado en base64.
   * Usamos su propio endpoint para garantizar compatibilidad exacta.
   */
  private async cifrar(texto: string): Promise<string> {
    const resp = await axios.get(`${this.baseUrl}/api/authentication/encrypt`, {
      params: { text: texto, aesKey: this.aesKey },
      timeout: 10_000,
    });
    if (typeof resp.data !== "string" || !resp.data) {
      throw new Error(`[Baneco] cifrar() devolvió respuesta inesperada: ${JSON.stringify(resp.data)}`);
    }
    return resp.data as string;
  }

  /**
   * Solicita un token de acceso fresco. El token vence en 30 minutos,
   * por eso se solicita uno nuevo en cada operación.
   */
  private async obtenerToken(): Promise<string> {
    const passwordCifrado = await this.cifrar(this.password);
    const resp = await axios.post(
      `${this.baseUrl}/api/authentication/authenticate`,
      { userName: this.username, password: passwordCifrado },
      { timeout: 10_000 },
    );
    if (resp.data?.responseCode !== 0) {
      throw new Error(`[Baneco] Autenticación falló: ${resp.data?.message ?? "sin mensaje"}`);
    }
    const token = resp.data?.token as string | undefined;
    if (!token) throw new Error("[Baneco] Autenticación no devolvió token");
    return token;
  }

  /**
   * Genera un QR de pago único.
   * Devuelve el qrId (para verificar estado) y la imagen en base64 (PNG).
   * El QR vence al día siguiente a las 23:59.
   */
  async generarQR(monto: number, descripcion: string): Promise<BanecoQRGenerado> {
    const token = await this.obtenerToken();
    const cuentaCifrada = await this.cifrar(this.cuenta);

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 1);
    expiry.setHours(23, 59, 0, 0);
    const dueDate = expiry.toISOString().split("T")[0]; // yyyy-MM-dd

    const transactionId = `BOT-${Date.now()}`;

    const resp = await axios.post(
      `${this.baseUrl}/api/qrsimple/generateQR`,
      {
        transactionId,
        accountCredit: cuentaCifrada,
        currency: "BOB",
        amount: monto,
        description: descripcion,
        dueDate,
        singleUse: true,
        modifyAmount: false,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      },
    );

    if (resp.data?.responseCode !== 0) {
      throw new Error(`[Baneco] generateQR falló: ${resp.data?.message ?? JSON.stringify(resp.data)}`);
    }

    const qrId = resp.data?.qrId as string | undefined;
    const qrImage = resp.data?.qrImage as string | undefined;
    if (!qrId || !qrImage) {
      throw new Error(`[Baneco] generateQR no devolvió qrId o qrImage`);
    }

    return { qrId, qrBase64: qrImage, expiry };
  }

  /**
   * Verifica el estado de un QR.
   * statusQrCode: 0 = pendiente, 1 = pagado, 9 = anulado
   */
  async verificarEstado(qrId: string): Promise<BanecoVerifStatus> {
    const token = await this.obtenerToken();
    const resp = await axios.get(
      `${this.baseUrl}/api/qrsimple/v2/statusQR/${qrId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      },
    );

    if (resp.data?.responseCode !== 0) return "error";
    const code = resp.data?.statusQrCode as number | undefined;
    if (code === 1) return "pagado";
    if (code === 0) return "pendiente";
    return "error";
  }

  /**
   * Cancela un QR activo (solo funciona si aún no fue pagado).
   */
  async cancelarQR(qrId: string): Promise<void> {
    try {
      const token = await this.obtenerToken();
      await axios.delete(`${this.baseUrl}/api/qrsimple/cancelQR`, {
        data: { qrId },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
    } catch {
      // No es crítico si falla la cancelación
    }
  }
}
