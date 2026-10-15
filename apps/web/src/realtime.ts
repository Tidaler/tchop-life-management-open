import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { deviceStore, getAccessToken } from './api';
import { CATALOG_KEY } from './catalog';

type RealtimeEvent =
  | { type: 'orders.changed'; orderId: string; tableId: string | null }
  | { type: 'tickets.changed'; ticketId: string; station: string }
  | { type: 'catalog.changed' }
  | { type: 'qr.changed'; tableId: string | null };

/**
 * Connexion temps réel au serveur local : à chaque événement, l'écran recharge les données concernées.
 * Si la connexion tombe, les écrans continuent de se rafraîchir périodiquement.
 */
export function useRealtime(enabled: boolean): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const socket = io({
      path: '/api/socket.io',
      transports: ['websocket'],
      // Relu à chaque (re)connexion : le jeton d'accès est renouvelé toutes les 15 minutes.
      auth: (cb) => cb({ token: getAccessToken(), deviceToken: deviceStore.get() }),
    });
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('change', (event: RealtimeEvent) => {
      if (event.type === 'orders.changed') void queryClient.invalidateQueries({ queryKey: ['orders'] });
      if (event.type === 'tickets.changed') void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      if (event.type === 'catalog.changed') void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
      if (event.type === 'qr.changed') {
        void queryClient.invalidateQueries({ queryKey: ['qr-requests'] });
        void queryClient.invalidateQueries({ queryKey: ['orders'] });
      }
    });
    return () => {
      socket.close();
      setConnected(false);
    };
  }, [enabled, queryClient]);

  return connected;
}
