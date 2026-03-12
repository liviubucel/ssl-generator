import { handleCreateOrder } from './acme';

(async () => {
  try {
    const result = await handleCreateOrder({
      domains: 'test-actalis.example.com',
      email: 'test@example.com',
      ca: 'actalis',
    });
    console.log('SUCCESS:', result);
  } catch (err) {
    console.error('ERROR:', err);
  }
})();
