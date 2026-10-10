export const visibleMusicServices = ['apple', 'spotify'];
export const defaultMusicService = visibleMusicServices[0];
export const chooseVisibleMusicService = (provider) => visibleMusicServices.includes(provider) ? provider : defaultMusicService;
export const chooseConnectedMusicService = (provider, isConnected) => visibleMusicServices.includes(provider) ? provider : visibleMusicServices.find(isConnected) || defaultMusicService;
