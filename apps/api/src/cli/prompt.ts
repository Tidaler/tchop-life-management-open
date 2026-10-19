import { createInterface } from 'node:readline';

/**
 * Saisie d'un secret au clavier sans l'afficher (ni dans le terminal, ni dans l'historique du shell).
 * Pour une installation automatisée, la valeur peut venir d'une variable d'environnement.
 */
export async function askSecret(question: string, envName: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY)
    throw new Error(`${question} : saisie impossible sans terminal (variable ${envName})`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Masque la saisie : seul le texte de la question est écrit.
  const output = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  output._writeToOutput = (text: string) => {
    if (!muted) output.output.write(text);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${question} : `, (value) => resolve(value));
    muted = true;
  });
  rl.close();
  process.stdout.write('\n');
  return answer;
}

/** Mot de passe solide : 12 caractères au moins, avec des lettres et des chiffres. */
export function checkPassword(password: string): string | null {
  if (password.length < 12) return 'Le mot de passe doit contenir au moins 12 caractères';
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password))
    return 'Le mot de passe doit mêler lettres et chiffres';
  return null;
}

/** PIN de 4 à 6 chiffres, ni répétitif (0000) ni suite (1234, 9876). */
export function checkPin(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'Le PIN doit contenir 4 à 6 chiffres';
  if (/^(\d)\1+$/.test(pin)) return 'PIN trop simple (chiffres identiques)';
  const digits = [...pin].map(Number);
  const step = digits[1]! - digits[0]!;
  if (Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - digits[i - 1]! === step)) {
    return 'PIN trop simple (suite de chiffres)';
  }
  return null;
}
