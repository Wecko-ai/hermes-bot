// Messages of the desktop shell, shown before the window exists (native error dialog).
// The window's own texts live in src/i18n. The system language decides: French if it is French, English otherwise.
const MESSAGES = {
  en: {
    portTaken: (port) => `Port ${port} is already in use. Quit the other copy of HermesBot, then start it again.`,
    noGateway: (origin) => `Hermes does not answer on ${origin}. Start the gateway (hermes gateway), or set sshHost to open an SSH tunnel.`,
    tunnelFailed: (host, reason) => `SSH tunnel ${host}: ${reason}`,
    tunnelSilent: (host) => `Hermes is missing. The SSH tunnel ${host} does not answer.`,
    forbiddenOrigin: () => 'Origin refused.',
    dictationConsent: () => ({
      message: 'Use the microphone for dictation in this window?',
      detail: 'This window shows HermesBot as served by another copy of HermesBot on this Mac, under another user account. Allow it to turn on the microphone when you click the dictation button? This holds until you quit HermesBot.',
      buttons: ['Allow', 'Don’t Allow'],
    }),
  },
  fr: {
    portTaken: (port) => `Le port ${port} est déjà pris. Quitte l’autre copie de HermesBot, puis relance.`,
    noGateway: (origin) => `Hermes ne répond pas sur ${origin}. Lance la gateway (hermes gateway), ou renseigne sshHost pour ouvrir un tunnel SSH.`,
    tunnelFailed: (host, reason) => `Tunnel SSH ${host} : ${reason}`,
    tunnelSilent: (host) => `Hermes est absent. Le tunnel SSH ${host} ne répond pas.`,
    forbiddenOrigin: () => 'Origine refusée.',
    dictationConsent: () => ({
      message: 'Utiliser le micro pour la dictée dans cette fenêtre ?',
      detail: 'Cette fenêtre affiche HermesBot servi par une autre copie de HermesBot sur ce Mac, sous un autre compte. L’autoriser à allumer le micro quand tu cliques sur le bouton de dictée ? Valable jusqu’à ce que tu quittes HermesBot.',
      buttons: ['Autoriser', 'Ne pas autoriser'],
    }),
  },
}

function messages(languages = []) {
  return languages.some((language) => String(language).toLowerCase().startsWith('fr')) ? MESSAGES.fr : MESSAGES.en
}

module.exports = { messages }
