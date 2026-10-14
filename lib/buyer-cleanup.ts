// What has to happen to everything that points at a buyer before that buyer
// goes away. Shared by Admin -> Users -> Delete and by deleting a simulated
// account (lib/simulated.ts), so the two can never drift apart.

import { prisma } from "@/lib/prisma";
import { MARKUP_INVITED, MARKUP_TIERED } from "@/lib/money";

/**
 * Attribution columns are plain Int columns with no foreign key, so removing a
 * buyer would otherwise leave publishers and listings pointing at an id that no
 * longer exists. A listing stuck on "invited" with a dead requestedById can
 * never give anyone the reduced rate again, so it is moved to standard pricing.
 *
 * Returns how many sites were moved to standard pricing.
 */
export async function detachBuyer(buyerId: number): Promise<number> {
  // Any link generated for this buyer that nobody has used yet. Left alone, a
  // publisher could accept it afterwards and every site they list would be
  // stamped with an id no buyer can ever match.
  await prisma.invite.deleteMany({ where: { requestedById: buyerId, acceptedAt: null } });
  await prisma.user.updateMany({ where: { invitedByBuyerId: buyerId }, data: { invitedByBuyerId: null } });
  const res = await prisma.listing.updateMany({
    where: { requestedById: buyerId, markupModel: MARKUP_INVITED },
    data: { markupModel: MARKUP_TIERED, requestedById: null },
  });
  // Sites we listed ourselves from this buyer's request keep markupModel
  // "requested" - that flag controls how the publisher is paid and how the
  // order is confirmed, not just pricing - but lose the dangling buyer id.
  await prisma.listing.updateMany({ where: { requestedById: buyerId }, data: { requestedById: null } });
  return res.count;
}
