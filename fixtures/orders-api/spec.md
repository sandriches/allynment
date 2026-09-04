# Orders API

This document describes the public GraphQL API for placing and managing orders. It is the source of truth for what clients can rely on.

## Users

Every customer has a `User` account. A user always has an `email`, which is required and unique. The `name` field is optional because some users sign up through social login without providing one.

The `legacyId` field on `User` is deprecated and will be removed in a future release. Clients should use `id` instead.

## Orders

There is an `Order` type representing a single purchase. Each order has a `status` field that tracks where it is in the fulfilment process, and a `total` which is a `Money` value in minor units.

The `placedAt` field on `Order` is a `String` in ISO-8601 format.

Every order has a `shippingAddress`, which is required at the time the order is placed and cannot be null.

Orders expose a `trackingNumber` field once the carrier has picked up the parcel.

The `note` field on `Order` is deprecated. Notes are now attached to individual line items.

An order may contain at most 50 line items.

### Order status

The `OrderStatus` enum includes `PENDING`, `PAID`, `SHIPPED`, `DELIVERED` and `CANCELLED`.

`OrderStatus` also includes `REFUNDED`, which is set when a refund has been fully processed.

### Refunds

A `Refund` type records money returned to the customer, including the amount and the reason.

## Querying orders

The `orders` query returns a paginated connection. It accepts `first` and `after` arguments for cursor-based pagination.

The `orders` query can be filtered by `customerId` so support staff can look up a specific customer's history.

## Behaviour

Users can cancel an order at any point until it has shipped.

Customers receive a confirmation email when an order is shipped.
