import { router } from 'expo-router';

export const go = {
  workout: (id: string, opts: { ex?: string; quick?: boolean } = {}) =>
    router.push({ pathname: '/workout/[id]', params: { id, ...(opts.ex && { ex: opts.ex }), ...(opts.quick && { quick: '1' }) } }),
  exercise: (id: string) => router.push({ pathname: '/exercise/[id]', params: { id } }),
  template: (id: string) => router.push({ pathname: '/template/[id]', params: { id } }),
  session: (id: string) => router.push({ pathname: '/session/[id]', params: { id } }),
  practice: () => router.push('/practice'),
  settings: () => router.push('/settings'),
  train: () => router.navigate('/train'),
};

/** Back if there is somewhere to go back to (a deep link or reload may have none), else Home. */
export function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}
