// Messages of the desktop shell, shown before the window exists (native error dialog).
// The window's own texts live in src/i18n. The system language decides: French if it is French, English otherwise.
const MESSAGES = {
  en: {
    portTaken: (port) => `Port ${port} is already in use. Quit the other copy of HermesBot, then start it again.`,
    noGateway: (origin) => `Hermes does not answer on ${origin}. Start the gateway (hermes gateway), or set sshHost to open an SSH tunnel.`,
    tunnelFailed: (host, reason) => `SSH tunnel ${host}: ${reason}`,
    tunnelSilent: (host) => `Hermes is missing. The SSH tunnel ${host} does not answer.`,
    forbiddenOrigin: () => 'Origin refused.',
  },
  fr: {
    portTaken: (port) => `Le port ${port} est déjà pris. Quitte l’autre copie de HermesBot, puis relance.`,
    noGateway: (origin) => `Hermes ne répond pas sur ${origin}. Lance la gateway (hermes gateway), ou renseigne sshHost pour ouvrir un tunnel SSH.`,
    tunnelFailed: (host, reason) => `Tunnel SSH ${host} : ${reason}`,
    tunnelSilent: (host) => `Hermes est absent. Le tunnel SSH ${host} ne répond pas.`,
    forbiddenOrigin: () => 'Origine refusée.',
  },
}

function messages(languages = []) {
  return languages.some((language) => String(language).toLowerCase().startsWith('fr')) ? MESSAGES.fr : MESSAGES.en
}

module.exports = { messages }
