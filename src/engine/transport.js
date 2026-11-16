import { buildTransport } from '../accounts/service.js';

/** Sends one prepared message. Sandbox accounts never touch the network. Tests replace `deliver`. */
export const transport = {
  async deliver(account, mail) {
    if (account.provider === 'sandbox') return { simulated: true, response: 'sandbox: not sent' };
    const t = await buildTransport(account);
    try { const info = await t.sendMail(mail); return { simulated: false, response: info.response, accepted: info.accepted, rejected: info.rejected }; }
    finally { t.close(); }
  },
};
