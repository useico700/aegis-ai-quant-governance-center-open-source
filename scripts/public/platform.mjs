export const supportsPublicEngine=platform=>platform==='linux'||platform==='darwin';
export function assertPublicEnginePlatform(platform=process.platform){
 if(!supportsPublicEngine(platform))throw Error('PUBLIC_ENGINE_REQUIRES_POSIX_USE_WSL2_ON_WINDOWS; install inside the Linux home filesystem, not a Windows mount');
}
