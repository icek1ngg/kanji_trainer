export class DataValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DataValidationError';
    this.details = details;
  }
}

export class DuplicateKanjiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DuplicateKanjiError';
    this.details = details;
  }
}

export class KanjiNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'KanjiNotFoundError';
    this.details = details;
  }
}
