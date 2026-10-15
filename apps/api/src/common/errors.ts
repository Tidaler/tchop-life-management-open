import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@tchop/db';

export const notFound = (what: string) =>
  new NotFoundException({ code: 'NOT_FOUND', message: `${what} introuvable` });

/** Verrou optimiste : quelqu'un a modifié la fiche entre-temps (docs/architecture/03, « Conflits »). */
export const versionConflict = () =>
  new ConflictException({
    code: 'VERSION_CONFLICT',
    message: 'La fiche a été modifiée entre-temps. Rechargez-la avant de recommencer.',
  });

export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
