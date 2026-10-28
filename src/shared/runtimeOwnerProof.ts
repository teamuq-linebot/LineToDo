import { join, resolve } from 'node:path'

/** Opaque in-process capability created only by core/runtime after an exclusive owner lock succeeds. */
declare const ownerLockBrand: unique symbol
export type RuntimeOwnerProof={readonly [ownerLockBrand]:true}

const issued=new WeakMap<object,{ownerDir:string;active:boolean;consumed:boolean}>()

export function createRuntimeOwnerProof(ownerDir:string):RuntimeOwnerProof{
  const proof=Object.freeze({})
  issued.set(proof,{ownerDir:resolve(ownerDir),active:true,consumed:false})
  return proof as RuntimeOwnerProof
}

/** One-shot claim scoped to the exact runtime dataDir and its canonical sidecar DB path. */
export function claimRuntimeOwnerProof(value:unknown,ownerDir:string,dbPath:string):value is RuntimeOwnerProof{
  if(value===null||typeof value!=='object')return false
  const record=issued.get(value as object)
  const canonicalOwnerDir=resolve(ownerDir)
  if(!record||!record.active||record.consumed||record.ownerDir!==canonicalOwnerDir||resolve(dbPath)!==resolve(join(canonicalOwnerDir,'line-todo.db')))return false
  record.consumed=true
  return true
}

export function revokeRuntimeOwnerProof(value:RuntimeOwnerProof):void{
  const record=issued.get(value as object)
  if(record)record.active=false
}
