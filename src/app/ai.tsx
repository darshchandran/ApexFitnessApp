import { useEffect } from 'react';

import { apex } from '@/services/useApex';
import { assistant, startAssistant } from '@/services/useAI';
import { ApexAI } from '@/ui/ai';
import { goBack } from '@/ui/nav';

export default function AIScreen() {
  useEffect(() => {
    void startAssistant();
  }, []);
  return <ApexAI assistant={assistant} today={apex.today()} onBack={goBack} allowServerEntry={__DEV__} />;
}
