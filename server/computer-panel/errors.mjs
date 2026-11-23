export class ComputerPanelError extends Error {
  constructor(code, status = 503) {
    super(code)
    this.name = 'ComputerPanelError'
    this.code = code
    this.status = status
  }
}