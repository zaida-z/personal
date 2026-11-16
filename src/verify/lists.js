// Curated seed lists. Extend at runtime via Settings (stored in the settings table).
export const DISPOSABLE_DOMAINS = new Set(`mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org sharklasers.com grr.la
10minutemail.com 10minutemail.net tempmail.com temp-mail.org temp-mail.io tempmail.net tempmailo.com tempail.com throwawaymail.com
yopmail.com yopmail.fr yopmail.net trashmail.com trashmail.net trashmail.de getnada.com nada.email dispostable.com maildrop.cc
mailnesia.com mintemail.com mytemp.email fakeinbox.com fakemailgenerator.com emailondeck.com mohmal.com moakt.com tmpmail.org
tmpmail.net tmail.ws burnermail.io spamgourmet.com spam4.me mailcatch.com inboxkitten.com discard.email discardmail.com
spambog.com spambox.us mailsac.com harakirimail.com incognitomail.org jetable.org luxusmail.org mailexpire.com mailforspam.com
mailhazard.com mailnull.com mailtemp.info meltmail.com mt2015.com nowmymail.com objectmail.com proxymail.eu rcpt.at
safetymail.info sogetthis.com spamavert.com spamfree24.org tempinbox.com tempr.email tempsky.com thankyou2010.com trbvm.com
wegwerfmail.de wegwerfmail.net wegwerfmail.org zetmail.com 33mail.com anonaddy.me dropmail.me emailfake.com emltmp.com
fexpost.com fextemp.com guerrillamailblock.com linshiyouxiang.net mailpoof.com minuteinbox.com one-time.email tempmailaddress.com
vomoto.com crazymailing.com einrot.com cuvox.de dayrep.com fleckens.hu gustr.com jourrapide.com rhyta.com superrito.com teleworm.us
armyspy.com mail-temp.com mailbox.in.ua owlymail.com 1secmail.com 1secmail.net 1secmail.org esiix.com wwjmp.com xojxe.com yoggm.com
byom.de trash-mail.com 0-mail.com 20minutemail.com 30minutemail.com mailmoat.com tempemail.net throwam.com binkmail.com bobmail.info
chammy.info devnullmail.com letthemeatspam.com mailinater.com mailinator.net mailinator2.com notmailinator.com reallymymail.com
safersignup.de sendspamhere.com spamherelots.com spamhereplease.com streetwisemail.com suremail.info thisisnotmyrealemail.com
tradermail.info veryrealemail.com zippymail.info`.split(/\s+/).filter(Boolean));

export const ROLE_LOCAL_PARTS = new Set(`abuse admin administrator accounts accounting billing careers contact customerservice
enquiries enquiry feedback finance hello help helpdesk hostmaster hr info inquiries jobs legal mail marketing media
news newsletter noreply no-reply office orders postmaster press privacy recruiting recruitment sales security service
services spam support sysadmin team tech undisclosed-recipients unsubscribe webmaster welcome donotreply do-not-reply
it payroll compliance partners partnerships reception bookings reservations`.split(/\s+/).filter(Boolean));

export const FREE_MAIL = new Set(`gmail.com googlemail.com yahoo.com yahoo.co.uk ymail.com outlook.com hotmail.com live.com msn.com
aol.com icloud.com me.com mac.com proton.me protonmail.com gmx.com gmx.net gmx.de mail.com zoho.com yandex.com yandex.ru
qq.com 163.com web.de`.split(/\s+/).filter(Boolean));

// Providers whose MX accept RCPT for any address then bounce later: an SMTP "250" proves nothing here.
export const ACCEPT_ALL_PROVIDERS = [/\.yahoodns\.net$/i, /\.aol\.com$/i, /\.mimecast\.com$/i, /\.pphosted\.com$/i, /\.barracudanetworks\.com$/i];

// Frequent typos of major mailbox domains -> suggestion.
export const DOMAIN_TYPOS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com', 'gamil.com': 'gmail.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'hotmail.con': 'hotmail.com', 'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com',
};
