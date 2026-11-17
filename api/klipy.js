import { handleKlipyRequest } from './_klipy.js';

export default async function handler(req, res) {
  await handleKlipyRequest(req, res, {
    apiKey: process.env.KLIPY_API_KEY || '',
  });
}
