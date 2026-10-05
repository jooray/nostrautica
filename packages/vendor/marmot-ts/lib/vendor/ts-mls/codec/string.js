import { mapDecoder } from "./tlsDecoder.js";
import { contramapBufferEncoder } from "./tlsEncoder.js";
import { varLenDataDecoder, varLenDataEncoder } from "./variableLength.js";
const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();
export const stringEncoder = contramapBufferEncoder(varLenDataEncoder, (s) => _textEncoder.encode(s));
export const stringDecoder = mapDecoder(varLenDataDecoder, (u) => _textDecoder.decode(u));
