# Kitchen Guide — Orders on WhatsApp

Customers order by chatting with the restaurant's WhatsApp number. When an order is confirmed,
**you receive a ticket on this phone**. Everything below is typed as a normal WhatsApp message to
the same number the ticket came from.

## When a ticket arrives
> Kitchen alert: you have a new order, number **7C6DF6C8**. Items: 2x Jollof Rice, 1x Chicken.
> Total: ₦6,500. Details: PICKUP, ETA 20-25 min.

Start preparing it. The customer has already been told the ready time.

## When the food is ready
Reply with **READY** and the order number from the ticket:

    READY 7C6DF6C8

The customer is told straight away that it's ready. (Capital letters don't matter.)

## Out of stock? Back in stock?
    OUT jollof rice       <- customers can no longer order it
    IN jollof rice        <- it's back on the menu

## Changed a price?
    PRICE jollof rice 3000

## Busy? Closing?
    CLOSED                <- new orders are politely declined
    OPEN                  <- accepting orders again

(Orders already confirmed are not affected.)

## Tell customers your hours, delivery areas and how to pay
Send one message beginning with INFO. The bot will use it to answer customers' questions.
It will only ever say what you write here.

    INFO Open 9am-9pm daily. We deliver to Wuse, Garki and Maitama, fee ₦1,500. Pay cash on pickup or delivery.

    INFO               <- shows what is saved
    INFO CLEAR         <- removes it

## If a customer cancels
You'll get: **ORDER CANCELLED by the customer — #NUMBER. Please do NOT prepare this order.**
A customer can only cancel before you start; after that they're asked to call you.

## Good to know
- **No ticket arrived but a customer says they ordered?** Ask them for their order number, or call the Relay support line.
- If the bot can't reach this phone, the Relay team is alerted and will phone you.
- **Please switch off the WhatsApp Business "greeting message" and "away message"** on this phone —
  they reply to the bot and confuse it.
- Keep this phone charged, online, and don't mute the chat.
