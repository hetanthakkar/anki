export type LocalCollectionInfo = {
  sqliteVersion: string;
  schemaVersion: number;
  persistent: boolean;
  crossOriginIsolated: boolean;
};

export type DeckSummary = {
  id: number;
  name: string;
  newCount: number;
  learningCount: number;
  reviewCount: number;
  totalCards: number;
};

export type DeckOptions = {
  deckId: number;
  presetId: number;
  deckName: string;
  presetName: string;
  usingDefaultPreset: boolean;
  newCardsPerDay: number;
  maximumReviewsPerDay: number;
  desiredRetentionPercent: number;
  maximumIntervalDays: number;
  learningStepsMinutes: number[];
  relearningStepsMinutes: number[];
  newCardGatherOrder: "deck" | "deckRandomNotes" | "ascending" | "descending" | "randomNotes" | "randomCards";
  newCardSortOrder: "template" | "gather" | "templateRandom" | "randomNote" | "randomCard";
  newCardReviewOrder: "mix" | "before" | "after";
  interdayLearningReviewOrder: "mix" | "before" | "after";
  reviewOrder: "due" | "dueDeck" | "deckDue" | "intervalAscending" | "intervalDescending" | "easeAscending" | "easeDescending" | "retrievabilityAscending" | "retrievabilityDescending" | "relativeOverdueness" | "random" | "added" | "reverseAdded";
  buryNewSiblings: boolean;
  buryReviewSiblings: boolean;
  buryInterdayLearningSiblings: boolean;
  leechThreshold: number;
  leechAction: "tag" | "suspend";
  minimumLapseIntervalDays: number;
  maximumAnswerSeconds: number;
  showAnswerTimer: boolean;
  stopTimerOnAnswer: boolean;
  fsrsWeights: number[];
  newCardInsertOrder: "sequential" | "random";
  secondsToShowQuestion: number;
  secondsToShowAnswer: number;
  questionTimeAction: "showAnswer" | "reminder";
  answerTimeAction: "bury" | "again" | "hard" | "good" | "reminder";
  newCardsIgnoreReviewLimit: boolean;
  limitsStartFromTop: boolean;
};

export type DeckOptionsInput = Omit<DeckOptions, "deckId" | "presetId" | "deckName" | "presetName" | "usingDefaultPreset">;

export type DeckPresetSummary = {
  id: number;
  name: string;
  useCount: number;
  isDefault: boolean;
};

export type CardState = "new" | "learning" | "review" | "relearning";

export type StudyCard = {
  id: number;
  noteId: number;
  deckId: number;
  deckName: string;
  notetypeName: string;
  cloze: boolean;
  templateName: string;
  fieldNames: string[];
  fields: string[];
  tags: string[];
  flag: number;
  reviews: number;
  lapses: number;
  dueLabel: string;
  timer: {
    show: boolean;
    maximumSeconds: number;
    stopOnAnswer: boolean;
    secondsToShowQuestion: number;
    secondsToShowAnswer: number;
    questionTimeAction: DeckOptions["questionTimeAction"];
    answerTimeAction: DeckOptions["answerTimeAction"];
  };
  questionHtml: string;
  answerHtml: string;
  cardCss: string;
  state: CardState;
  intervalDays: number;
  typedAnswer?: {
    field: string;
    correct: string;
  };
  answerOptions: Array<{
    rating: ReviewRating;
    intervalLabel: string;
  }>;
};

export type ReviewRating = 1 | 2 | 3 | 4;

export type AnswerCardResult = {
  leeched: boolean;
  suspended: boolean;
};

export type CollectionStats = {
  scopeName: string;
  today: {
    reviews: number;
    timeMs: number;
  };
  last30Days: {
    reviews: number;
    timeMs: number;
    retentionPercent: number | null;
    answers: {
      again: number;
      hard: number;
      good: number;
      easy: number;
    };
  };
  streak: {
    current: number;
    longest: number;
  };
  cards: {
    total: number;
    new: number;
    learning: number;
    review: number;
    suspended: number;
    buried: number;
  };
  daily: Array<{
    date: string;
    reviews: number;
    timeMs: number;
  }>;
  forecast: Array<{
    date: string;
    due: number;
  }>;
  maturity: {
    young: number;
    mature: number;
    averageIntervalDays: number | null;
  };
};

export type NoteTypeSummary = {
  id: number;
  name: string;
  kind: "standard" | "cloze" | "image-occlusion";
  fields: string[];
  imageOcclusionFields?: {
    occlusions: number;
    image: number;
    header: number;
    backExtra: number;
    comments?: number;
  };
};

export type NoteTypeField = {
  name: string;
  sourceOrdinal: number | null;
  rtl: boolean;
  font: string;
  size: number;
};

export type NoteTypeTemplate = {
  name: string;
  sourceOrdinal: number | null;
  qfmt: string;
  afmt: string;
  deckId: number | null;
};

export type NoteTypeDetails = {
  id: number;
  name: string;
  kind: "standard" | "cloze" | "image-occlusion";
  fields: NoteTypeField[];
  templates: NoteTypeTemplate[];
  css: string;
  noteCount: number;
  cardCount: number;
  canDelete: boolean;
};

export type NoteTypeInput = {
  id: number;
  name: string;
  fields: NoteTypeField[];
  templates: NoteTypeTemplate[];
  css: string;
};

export type ApkgImportResult = {
  notes: number;
  cards: number;
  media: number;
  skippedNotes: number;
  decks: string[];
  keptScheduling: boolean;
};

export type CollectionBackupResult = {
  filename: string;
  bytes: ArrayBuffer;
  notes: number;
  cards: number;
  reviews: number;
  media: number;
};

export type CollectionRestoreResult = {
  notes: number;
  cards: number;
  reviews: number;
  media: number;
};

export type MediaOverview = {
  files: number;
  bytes: number;
  referencedFiles: number;
  unusedFiles: number;
  unusedBytes: number;
};

export type MediaCleanupResult = {
  files: number;
  bytes: number;
};

export type BrowserCard = {
  id: number;
  deckId: number;
  deckName: string;
  ordinal: number;
  flag: number;
  due: number;
  dueLabel: string;
  templateName: string;
  state: CardState;
  status: "active" | "suspended" | "buried";
  intervalDays: number;
  reviews: number;
  lapses: number;
};

export type BrowserNote = {
  id: number;
  notetypeId: number;
  notetypeName: string;
  cloze: boolean;
  fieldNames: string[];
  fields: string[];
  tags: string[];
  preview: string;
  modified: number;
  cards: BrowserCard[];
};

export type BrowseNotesResult = {
  notes: BrowserNote[];
  total: number;
  offset: number;
  hasMore: boolean;
};

export type BrowserSort = "sortField" | "cardType" | "due" | "deck";
export type BrowserOptions = {
  query: string;
  mode: "cards" | "notes";
  sort: BrowserSort;
  descending: boolean;
  offset: number;
  currentDeckId: number | null;
};
export type BrowserResults = {
  rows: { note: BrowserNote; card: BrowserCard }[];
  total: number;
  hasMore: boolean;
};
export type BrowserMetadata = {
  tags: string[];
  notetypes: { id: number; name: string; templates: { ordinal: number; name: string }[] }[];
};

export type DbCommand =
  | { type: "init" }
  | { type: "listDecks" }
  | { type: "listNotetypes" }
  | { type: "listNoteTypeDetails" }
  | { type: "createNoteType"; name: string; kind: "standard" | "cloze"; sourceId: number | null }
  | { type: "updateNoteType"; noteType: NoteTypeInput }
  | { type: "deleteNoteType"; noteTypeId: number }
  | { type: "createDeck"; name: string }
  | { type: "renameDeck"; deckId: number; name: string }
  | { type: "deleteDeck"; deckId: number }
  | { type: "getDeckOptions"; deckId: number }
  | { type: "saveDeckOptions"; deckId: number; options: DeckOptionsInput }
  | { type: "resetDeckOptions"; deckId: number }
  | { type: "listDeckPresets" }
  | { type: "applyDeckPreset"; deckId: number; presetId: number }
  | { type: "applyDeckPresetToSubdecks"; deckId: number; presetId: number }
  | { type: "createDeckPreset"; name: string; sourcePresetId: number }
  | { type: "renameDeckPreset"; presetId: number; name: string }
  | { type: "deleteDeckPreset"; presetId: number }
  | { type: "addNote"; deckId: number; notetypeId: number; fields: string[] }
  | { type: "addBasicNote"; deckId: number; front: string; back: string }
  | { type: "addClozeNote"; deckId: number; text: string; extra: string }
  | { type: "storeMedia"; filename: string; bytes: ArrayBuffer }
  | { type: "importApkg"; bytes: ArrayBuffer; keepScheduling: boolean }
  | { type: "exportCollection" }
  | { type: "restoreCollection"; bytes: ArrayBuffer }
  | { type: "getMediaOverview" }
  | { type: "removeUnusedMedia" }
  | { type: "browseCollection"; options: BrowserOptions }
  | { type: "browserMetadata" }
  | { type: "setCardFlag"; cardId: number; flag: number }
  | { type: "browseNotes"; query: string; deckId: number | null; offset: number }
  | { type: "updateNote"; noteId: number; fields: string[]; tags: string[] }
  | { type: "deleteNote"; noteId: number }
  | { type: "setCardStatus"; cardId: number; status: BrowserCard["status"] }
  | { type: "moveCard"; cardId: number; deckId: number }
  | { type: "getCollectionStats"; deckId: number | null }
  | { type: "getNextCard"; deckId: number }
  | { type: "getStudyCard"; cardId: number }
  | { type: "answerCard"; cardId: number; rating: ReviewRating; timeMs: number }
  | { type: "undoLastReview" }
  | { type: "setNoteStatus"; noteId: number; status: "suspended" | "buried" }
  | { type: "setNoteMarked"; noteId: number; marked: boolean }
  | { type: "resetCard"; cardId: number }
  | { type: "setCardDue"; cardId: number; days: number };

export type DbRequest = DbCommand & { id: number };

export type DbResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  progress?: string;
};
