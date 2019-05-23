export type AcceptableExtensions = 'js'|'ts'|'html';

export interface CodeEditorTextarea extends HTMLTextAreaElement {
  extension: 'js'|'ts'|'html';
  name: string;
}
export interface FileRecord {
  name: string;
  extension: AcceptableExtensions;
  content: string;
  isTemplate?: boolean
}

export interface FileOptions {
  isTemplate?: boolean
}
export interface ProjectManifest {
  files?: {
    [filename: string]: FileOptions
  }
}
export interface Message {
  type: MESSAGE_TYPES;
  message?: any|never;
}

export enum MESSAGE_TYPES {
  ESTABLISH_HANDSHAKE = "ESTABLISH_HANDSHAKE",
  HANDSHAKE_RECEIVED = "HANDSHAKE_RECEIVED",
  PROJECT_CONTENT = "PROJECT_CONTENT",
  RESPONSES_READY = "RESPONSES_READY",
  AWAITING_CONTENT = "AWAITING_CONTENT",
  CONTENTS_CHANGED = "CONTENTS_CHANGED",
  RESPONSES_CLEARED = "RESPONSES_CLEARED",
}

export interface EstablishHandshake extends Message {
  type: MESSAGE_TYPES.ESTABLISH_HANDSHAKE;
}

export interface HandshakeRecieved extends Message {
  type: MESSAGE_TYPES.HANDSHAKE_RECEIVED;
}

export interface ProjectContent extends Message {
  type: MESSAGE_TYPES.PROJECT_CONTENT,
  message: FileRecord[]
}

export interface ResponsesReady extends Message {
  type: MESSAGE_TYPES.RESPONSES_READY,
}

export interface AwaitingContent extends Message {
  type: MESSAGE_TYPES.AWAITING_CONTENT,
}

export interface ContentsChanged extends Message {
  type: MESSAGE_TYPES.CONTENTS_CHANGED,
}